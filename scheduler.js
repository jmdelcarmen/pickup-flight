'use strict';

module.exports = function (context, cb) {
  const axios = require('axios');
  const async = require('async');
  const mongoose = require('mongoose');
  const Twilio = require('twilio');
  const FLIGHT_AWARE_AUTH = context.secrets.FLIGHT_AWARE_AUTH;
  const DB_URI = context.secrets.DB_URI;
  const TWILIO_SID = context.secrets.TWILIO_SID;
  const TWILIO_AUTH_TOKEN = context.secrets.TWILIO_AUTH_TOKEN;
  const TWILIO_VALID_NUMBER = context.secrets.TWILIO_VALID_NUMBER;
  const TwilioClient = new Twilio(TWILIO_SID, TWILIO_AUTH_TOKEN);

  mongoose.connect(DB_URI);

  const Flight = mongoose.models.Flight || mongoose.model('Flight', new mongoose.Schema({
    notified: Boolean,
    uid: String,
    code: String,
    origin: String,
    destination: String,
    departureTime: Date,
    arrivalTime: Date,
    respondToPhone: String,
    notificationToArrivalDelta: Number, // in seconds
  }, { timestamps: true }));

  // Main
  async.waterfall([
    (waterfallCb) => { Flight.find({ notified: false }).lean().exec(waterfallCb); },
    (flights, waterfallCb) => { updateFlightArrivalTimes(flights, waterfallCb); },
    (updatedFlights, waterfallCb) => { filterFlightsToNotify(updatedFlights, waterfallCb); },
    (flightsToNotify, waterfallCb) => { notifyFlights(flightsToNotify, waterfallCb); },
  ], (waterfallErr, result) => {
    if (waterfallErr) { cb(waterfallErr.message); }

    cb(null, { success: true, result });
  });

  // Helpers
  function updateFlightArrivalTimes(flights, cb) {
    const updatedFlights = [];

    async.forEachOf(flights, (flight, i, innerCb) => {
      fetchFlightDataWithUID(flight.uid, (err, fetchedFlight) => {
        if (err) { innerCb(err); return; }

        Flight.findByIdAndUpdate(flight._id, { $set: { arrivalTime: fetchedFlight.estimatedarrivaltime * 1000 } }, (updateErr, updatedFlight) => {
          if (updateErr) { innerCb(updateErr); return; }

          updatedFlights.push(updatedFlight);
          innerCb();
        });
      });
    }, (err) => {
      if (err) { cb(err); return; }
      cb(null, updatedFlights);
    });
  }

  function fetchFlightDataWithUID(flightUID, cb) {
    const requestOptions = {
      url: `http://flightxml.flightaware.com/json/FlightXML2/FlightInfoEx?ident=${flightUID}`,
      method: 'GET',
      headers: { Authorization: FLIGHT_AWARE_AUTH },
    };

    axios(requestOptions).then((res) => {
      cb(null, res.data.FlightInfoExResult.flights[0]);
    }).catch(cb);
  }

  function filterFlightsToNotify(flights, cb) {
    const flightsToNotify = [];

    async.forEachOf(flights, (flight, i, innerCb) => {
      if (!flight.arrivalTime) { innerCb(); return; }

      const currentTime = new Date().getTime();
      const arrivalTime = flight.arrivalTime.getTime();
      const currentDelta = (currentTime - arrivalTime) / 1000;
      const deltaToSend = flight.notificationToArrivalDelta;

      if (currentDelta <= deltaToSend) {
        flightsToNotify.push(flight);
      }

      innerCb();
    }, (err) => {
      if (err) { cb(err); return; }
      cb(null, flightsToNotify);
    });
  }

  function notifyFlights(flights, cb) {
    async.forEachOf(flights, (flight, i, innerCb) => {
      const deltaMins = Math.round((flight.arrivalTime.getTime() - new Date().getTime()) / (60 * 1000));

      TwilioClient.messages.create({
        body: `\n------------------------\nThis is a notification from PickupFlight.\n------------------------\nFlight ${flight.code} from ${flight.origin} to ${flight.destination} is arriving in ${deltaMins}mins.`,
        to: flight.respondToPhone,
        from: TWILIO_VALID_NUMBER,
      }, (err, message) => {
        if (err) { cb(err); return; }

        Flight.findByIdAndUpdate(flight._id, { $set: { notified: true } }, cb);
      });
    }, cb);
  }
};

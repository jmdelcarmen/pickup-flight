'use strict';

module.exports = function(context, cb) {
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
  const reply = context.body.Body;
  replyHandler(reply)(context, cb);
  
  // Helpers
  function replyHandler(message) {
    if(/^start$/ig.test(message)) {
      return replyWithSubscriptionInstructions;
    } else if (message.split(', ').length === 2) {
      const flightNumber = message.split(', ')[0];
      const notificationToArrivalDelta = Number(message.split(', ')[1]) * 60;
  
      return (context, cb) => {
        async.waterfall([
          (waterfallCb) => { fetchFlightData({ flight: flightNumber, notificationToArrivalDelta }, waterfallCb); },
          (flight, waterfallCb) => { saveFlight(context, flight, waterfallCb); },
          (savedFlight, waterfallCb) => { replyToSubscription(savedFlight, context, waterfallCb) },
        ], (err, result) => {
          cb(err, { result });
        });
      };
    } else {
      return (context, cb) => {
        TwilioClient.messages.create({
          body: '\n------------------------\nReply format is invalid, please reply with a valid format.\n------------------------\n',
          to: context.body.From,
          from: TWILIO_VALID_NUMBER,
        }, (sendErr, message) => {
          if (sendErr) { cb(sendErr); return; }
          cb(null, { message });
        });
      };
    }
  }
  
  function replyWithSubscriptionInstructions(context, cb) {
    TwilioClient.messages.create({
      body: `
      \n------------------------\nWelcome to PickupFlight. To start receiving notifications on a certain flight, reply with this format: <flightNumber>, <minsBeforeLanding>\n------------------------\nExample reply:\nSWA182, 45\n------------------------\n
      `,
      to: context.body.From,
      from: TWILIO_VALID_NUMBER,
    }, (sendErr, message) => {
      if (sendErr) { cb(sendErr); return; }
      cb(null, { message });
    });
  }
  
  function replyToSubscription(flight, context, cb) {
    const validFlight = flight.uid && flight.code;
    const messageBody = validFlight
      ? `\n------------------------\nFlight ${flight.code} is currently being tracked. You will recieve a notification ${Math.round(flight.notificationToArrivalDelta / 60)}mins before the flight lands.\n------------------------\n`
      : `\n------------------------\nSorry, you provided an invalid flight number.\n------------------------\n`;
  
     TwilioClient.messages.create({
      body: messageBody,
      to: context.body.From,
      from: TWILIO_VALID_NUMBER,
    }, (sendErr, message) => {
      if (sendErr) { cb(sendErr); return; }
      cb(null, { message });
    });
  }
  
  function saveFlight(context, flight, cb) {
    const newFlight = new Flight({
      notified: false,
      uid: flight.faFlightID,
      code: flight.ident,
      origin: flight.origin,
      destination: flight.destination,
      departureTime: flight.departureTime * 1000,
      arrivalTime: null, // will be set in scheduler
      respondToPhone: context.body.From,
      notificationToArrivalDelta: flight.notificationToArrivalDelta,
    });
    newFlight.save((saveErr, savedFlight) => {
      if (saveErr) { cb(saveErr); return; }
      cb(saveErr, savedFlight);
    });
  }
  
  function fetchFlightData(options, cb) {
    const requestOptions = {
      url: `http://flightxml.flightaware.com/json/FlightXML2/InFlightInfo?ident=${options.flight}`,
      method: 'GET',
      headers: { Authorization: FLIGHT_AWARE_AUTH },
    };
    axios(requestOptions).then((res) => {
      const flight = res.data.InFlightInfoResult;
      flight.notificationToArrivalDelta = options.notificationToArrivalDelta;
  
      cb(null, flight);
    }).catch(cb);
  }
};

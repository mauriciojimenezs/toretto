/**
 * Copyright 2017 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License'); you may not
 * use this file except in compliance with the License. You may obtain a copy of
 * the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS, WITHOUT
 * WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
 * License for the specific language governing permissions and limitations under
 * the License.
 */

'use strict';

const ConversationV1 = require('watson-developer-cloud/conversation/v1');
const DiscoveryV1 = require('watson-developer-cloud/discovery/v1');
const VisualRecognitionV3 = require('watson-developer-cloud/visual-recognition/v3');
const redis = require('redis');
const request = require('request');

function errorResponse(reason) {
  return {
    text: 400,
    message: reason || 'An unexpected error occurred. Please try again later.'
  }
}

// Using some globals for now
let conversation;
let redisClient;
let context;


function initClients(args) {
  // Connect a client to Watson Conversation
  conversation = new ConversationV1({
    username: args.CONVERSATION_USERNAME,
    password: args.CONVERSATION_PASSWORD,
    version_date: ConversationV1.VERSION_DATE_2017_04_21
  });
  console.log('Connected to Watson Conversation');

  // Connect a client to Redis
  if (args.REDIS_URI) {
    redisClient = redis.createClient(13623, args.REDIS_URI);
    redisClient.auth('12345678', function (err) {
      if (err) throw err;
    });
  } else if (args.REDIS_PORT && args.REDIS_IP) {
    redisClient = redis.createClient(args.REDIS_PORT, args.REDIS_IP);
  } else {
    redisClient = redis.createClient();
    redisClient.auth('12345678', function (err) {
      if (err) throw err;
    });
  }
  console.log('Connected to Redis');
}

function getSessionContext(sessionId) {
  console.log('sessionId: ' + sessionId);

  return new Promise(function(resolve, reject) {
    redisClient.get(sessionId, function(err, value) {
      if (err) {
        console.error(err);
        reject('Error getting context from Redis.');
      }
      // set global context
      context = value ? JSON.parse(value) : {};
      console.log('context:');
      console.log(context);
      resolve();
    });
  });
}

function callVisualRecognition(params){
 
  return new Promise(function(resolve, reject){
    if (params.entry[0].messaging[0].message && 
      params.entry[0].messaging[0].message.attachments && 
      params.entry[0].messaging[0].message.attachments[0].type == 'image') {

      var postUrl = params.entry[0].messaging[0].message.attachments[0].payload.url;
      var visualRecognition = new VisualRecognitionV3({
        iam_apikey: params.vr_api_key,
        version_date: '2018-03-19'
      });

      var classifier_ids = [params.vr_classifier_id];
      var threshold = 0.5;

      var args = {
        url: postUrl,
        classifier_ids: classifier_ids,
        threshold: threshold
      };

      visualRecognition.classify(args, function(err, response) {
        if (err)
          console.error("errorrr al intentar visualizar la imagen", JSON.stringify(err));
        else
          console.log("responseeeee image", JSON.stringify(response, null, 2));
          context.images = response;

          resolve("image");
      });


    }else {
      var request = params.entry[0].messaging[0].message.text;
      resolve(request);
    }
  })
}

function conversationMessage(request, workspaceId) {
  return new Promise(function(resolve, reject) {
    const input = request ? request : '';
    console.log('WORKSPACE_ID: ' + workspaceId);
    console.log('Input text: ' + input);

    conversation.message(
      {
        input: { text: input },
        workspace_id: workspaceId,
        context: context
      },
      function(err, watsonResponse) {
        if (err) {
          console.error(err);
          reject('Error talking to Watson.');
        } else {
          console.log(watsonResponse);
          context = watsonResponse.context; // Update global context
          resolve(watsonResponse);
        }
      }
    );
  });
}

/**
 *  Posts Conversation response to the message sender using the Facebook API https://graph.facebook.com/v2.6/me/messages
 *  as a default. If a different url is specified in params.url then it will post to that instead.
 *
 *  @param  {JSON} Facebook post parameters
 *  @postUrl  {string} Url for posting the response
 *  @accessToken  {string} auth token to send with the post request
 *
 *  @return - status of post request sent to Facebook POST API
 */
function postFacebook(response, params, postUrl, accessToken) {
  console.log('Entro a enviar a facebook');

  const facebookParams = {
    recipient: {
      id: params.entry[0].messaging[0].sender.id
    },
    // Get payload for regular text message or interactive message
    message: getMessageType(response)
  };


  return new Promise(function(resolve, reject){
    request(
      {
        url: postUrl,
        qs: { access_token: accessToken },
        method: 'POST',
        json: facebookParams
      },
      function(error, response)  {
        if (error) {
          return reject(error.message);
        }
        if (response) {
          if (response.statusCode === 200) {
            // Facebook expects a "200" string/text response instead of a JSON.
            // With Cloud Functions if we have to return a string/text, then we'd have to specify
            // the field "text" and assign it a value that we'd like to return. In this case,
            // the value to be returned is a statusCode.
            return resolve({
              text: response.statusCode,
              params,
              url: postUrl
            });
          }
          return reject(
            `Action returned with status code ${response.statusCode}, message: ${response.statusMessage}`
          );
        }
        reject(`An unexpected error occurred when sending POST to ${postUrl}.`);
      }
    );
  });
}



function sendResponse(resolve) {
  console.log('Begin sendResponse');

  // Everytime facebook pings the "receive" endpoint/webhook, it expects a
  // "200" string/text response in return. In Cloud Functions, if we'd want to return
  // a string response, then it's necessary that we add a field "text" and the
  // response "200" as the value. The field "text" tells Cloud Functions that this
  // endpoint must return a "text" response.
  // Response code 200 only tells us that receive was able to execute it's code
  // successfully but it doesn't really tell us if the sub-pipeline or the
  // batched-messages pipeline that are invoked as a part of it returned a successful
  // response or not. Hence, we return the activation id of the appropriate action so
  // that the user can retrieve it's details for debugging purposes.
  resolve({
    text: 200,
    message: `Response code 200 above only tells you that receive action was invoked successfully.
    However, it does not really say if the Facebook API was invoked successfully. `
  });

}

/**
 * Function retrieves interactive message payload or regular text message payload
 * from the params that it receives from conversation
 * @param {JSON} params - Parameters coming into this action
 * @return {JSON} - Either an attachment or a text message payload
 */
function getMessageType(params) {
  const interactiveMessage = params.output.facebook;
  const textMessage = params.output.text.join(' ');
  // If dialog node sends back output.facebook (used for interactive messages such as
  // buttons and templates)
  if (interactiveMessage) {
    // An acceptable interactive JSON could either be of form -> output.facebook or
    // output.facebook.message. Facebook's Send API accepts the "message" payload. So,
    // if you already wrap your interactive message inside "message" object, then we
    // accept it as-is. And if you don't wrap your interactive message inside "message"
    // object, then the code wraps it for you.
    if (interactiveMessage.message) {
      console.log('Output interactive: ' + interactiveMessage.message);
      return interactiveMessage.message;
    }
    console.log('Output interactive: ' + interactiveMessage);
    return interactiveMessage;
  }
  console.log('Output text: ' + textMessage);
  // if regular text message is received
  return { text: textMessage };
}

function saveSessionContext(sessionId) {
  console.log('Begin saveSessionContext');
  console.log(sessionId);

  // Save the context in Redis. Can do this after resolve(response).
  if (context) {
    const newContextString = JSON.stringify(context);
    // Saved context will expire in 600 secs.
    redisClient.set(sessionId, newContextString, 'EX', 600);
    console.log('Saved context in Redis');
    console.log(sessionId);
    console.log(newContextString);
  }
}

/** Checks if it's a URL verification event
 *
 * @param  {JSON} params - Parameters passed into the action
 * @return {boolean} - true or false
 */
function isURLVerificationEvent(args) {
  if (
    args['hub.mode'] !== 'subscribe' ||
    args['hub.verify_token'] !== args.facebook_verification_token
  ) {
    return false;
  }
  return true;
}

/** Checks if object is of type page
 *
 * @param  {JSON} params - Parameters passed into the action
 * @return {boolean} - true or false
 */
function isPageObject(params) {
  if (!(params.object === 'page')) {
    return false;
  }
  return true;
}

/**
 * Receives a either a url-verification-type message or a regular page request from Facebook
 *   and returns the appropriate response depending on the type of event that is detected.
 *
 * @param  {JSON} params - Facebook Callback API parameters as outlined by
 *                       https://developers.facebook.com/docs/graph-api/webhooks#callback
 * @return {Promise} - Result of the Facebook callback API
 */
function main(args) {
  console.log('Begin action');
  return new Promise(function(resolve, reject) {
    try {
      if (isURLVerificationEvent(args)) {
        // Challege value is returned
          return resolve( { text: args['hub.challenge'] } );
      } else if (isPageObject(args)) {
        // Every time facebook makes a POST request to the webhook endpoint, it sends along
        // x-hub-signature header which basically contains SHA1 key. In order to make sure, that
        // the request is coming from facebook, it is important to calculate the HMAC key using
        // app-secret and the request payload and compare it against the x-hub-signature header.
          const sessionId = args.entry[0].messaging[0].sender.id;
          const postUrl = 'https://graph.facebook.com/v2.6/me/messages';
          initClients(args);
          getSessionContext(sessionId)
          .then(()=>callVisualRecognition(args))
          .then(request => conversationMessage(request, args.WORKSPACE_ID))
          .then(actionResponse => postFacebook(actionResponse, args, postUrl, args.page_access_token))
          .then(() => sendResponse( resolve))
          .then(() => saveSessionContext(sessionId))
          .catch(err => { reject(errorResponse(err)) })
      } else {
        reject({
          text: 400,
          message: 'Neither a page type request nor a verfication type request detected'
        });
      }
    } catch (err) {
      console.error('Caught error: ', err);
      console.log(err);
      reject(errorResponse(err));
    }
  });
}

exports.main = main;

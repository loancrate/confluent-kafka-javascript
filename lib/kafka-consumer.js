/*
 * confluent-kafka-javascript - Node.js wrapper  for RdKafka C/C++ library
 *
 * Copyright (c) 2016-2023 Blizzard Entertainment
 *           (c) 2023 Confluent, Inc.
 *
 * This software may be modified and distributed under the terms
 * of the MIT license.  See the LICENSE.txt file for details.
 */
'use strict';

module.exports = KafkaConsumer;

var Client = require('./client');
var util = require('util');
var Kafka = require('../librdkafka');
var KafkaConsumerStream = require('./kafka-consumer-stream');
var LibrdKafkaError = require('./error');
var TopicPartition = require('./topic-partition');
var shallowCopy = require('./util').shallowCopy;
var DEFAULT_CONSUME_LOOP_TIMEOUT_DELAY = 500;
var DEFAULT_CONSUME_TIME_OUT = 1000;
const DEFAULT_IS_TIMEOUT_ONLY_FOR_FIRST_MESSAGE = false;
util.inherits(KafkaConsumer, Client);

/**
 * KafkaConsumer class for reading messages from Kafka
 *
 * This is the main entry point for reading data from Kafka. You
 * configure this like you do any other client, with a global
 * configuration and default topic configuration.
 *
 * Once you instantiate this object, connecting will open a socket.
 * Data will not be read until you tell the consumer what topics
 * you want to read from.
 *
 * @param {object} conf - Key value pairs to configure the consumer
 * @param {object} topicConf - Key value pairs to create a default
 * topic configuration
 * @extends Client
 * @constructor
 */
function KafkaConsumer(conf, topicConf) {
  if (!(this instanceof KafkaConsumer)) {
    return new KafkaConsumer(conf, topicConf);
  }

  conf = shallowCopy(conf);
  topicConf = shallowCopy(topicConf);

  var onRebalance = conf.rebalance_cb;

  var self = this;

  // If rebalance is undefined we don't want any part of this
  if (onRebalance && typeof onRebalance === 'boolean') {
    conf.rebalance_cb = function(err, assignment) {
      // Create the librdkafka error
      err = LibrdKafkaError.create(err);
      // Emit the event
      self.emit('rebalance', err, assignment);

      // That's it
      try {
        if (err.code === -175 /*ERR__ASSIGN_PARTITIONS*/) {
          if (self.rebalanceProtocol() === 'COOPERATIVE') {
            self.incrementalAssign(assignment);
          } else {
            self.assign(assignment);
          }
        } else if (err.code === -174 /*ERR__REVOKE_PARTITIONS*/) {
          if (self.rebalanceProtocol() === 'COOPERATIVE') {
            self.incrementalUnassign(assignment);
          } else {
            self.unassign();
          }
        }
      } catch (e) {
        // Ignore exceptions if we are not connected
        if (self.isConnected()) {
          self.emit('rebalance.error', e);
        }
      }
    };
  } else if (onRebalance && typeof onRebalance === 'function') {
    /*
     * Once this is opted in to, that's it. It's going to manually rebalance
     * forever. There is no way to unset config values in librdkafka, just
     * a way to override them.
     */

     conf.rebalance_cb = function(err, assignment) {
       // Create the librdkafka error
       err = err ? LibrdKafkaError.create(err) : undefined;

       self.emit('rebalance', err, assignment);
       onRebalance.call(self, err, assignment);
     };
  }

  // Same treatment for offset_commit_cb
  var onOffsetCommit = conf.offset_commit_cb;

  if (onOffsetCommit && typeof onOffsetCommit === 'boolean') {
    conf.offset_commit_cb = function(err, offsets) {
      if (err) {
        err = LibrdKafkaError.create(err);
      }
      // Emit the event
      self.emit('offset.commit', err, offsets);
    };
  } else if (onOffsetCommit && typeof onOffsetCommit === 'function') {
    conf.offset_commit_cb = function(err, offsets) {
      if (err) {
        err = LibrdKafkaError.create(err);
      }
      // Emit the event
      self.emit('offset.commit', err, offsets);
      onOffsetCommit.call(self, err, offsets);
    };
  }

  // Note: This configuration is for internal use for now, and hence is not documented, or
  // exposed via types.
  const queue_non_empty_cb = conf.queue_non_empty_cb || null;
  delete conf.queue_non_empty_cb;

  Client.call(this, conf, Kafka.KafkaConsumer, topicConf);

  this.globalConfig = conf;
  this.topicConfig = topicConf;

  this._consumeTimeout = DEFAULT_CONSUME_TIME_OUT;
  this._consumeLoopTimeoutDelay = DEFAULT_CONSUME_LOOP_TIMEOUT_DELAY;
  this._consumeIsTimeoutOnlyForFirstMessage = DEFAULT_IS_TIMEOUT_ONLY_FOR_FIRST_MESSAGE;

  if (queue_non_empty_cb) {
    this._cb_configs.event.queue_non_empty_cb = queue_non_empty_cb;
  }
}

/**
 * Set the default consume timeout provided to c++land
 * @param {number} timeoutMs - number of milliseconds to wait for a message to be fetched
 */
KafkaConsumer.prototype.setDefaultConsumeTimeout = function(timeoutMs) {
  this._consumeTimeout = timeoutMs;
};

/**
 * Set the default sleep delay for the next consume loop after the previous one has timed out.
 * @param {number} intervalMs - number of milliseconds to sleep after a message fetch has timed out
 */
KafkaConsumer.prototype.setDefaultConsumeLoopTimeoutDelay = function(intervalMs) {
  this._consumeLoopTimeoutDelay = intervalMs;
};

/**
 * If true:
 *  In consume(number, cb), we will wait for `timeoutMs` for the first message to be fetched.
 *  Subsequent messages will not be waited for and will be fetched (upto `number`) if already ready.
 *
 * If false:
 *  In consume(number, cb), we will wait for upto `timeoutMs` for each message to be fetched.
 *
 * @param {boolean} isTimeoutOnlyForFirstMessage
 */
KafkaConsumer.prototype.setDefaultIsTimeoutOnlyForFirstMessage = function(isTimeoutOnlyForFirstMessage) {
  this._consumeIsTimeoutOnlyForFirstMessage = isTimeoutOnlyForFirstMessage;
};

/**
 * Get a stream representation of this KafkaConsumer
 *
 * @see TopicReadable
 * @example
 * var consumerStream = Kafka.KafkaConsumer.createReadStream({
 * 	'metadata.broker.list': 'localhost:9092',
 * 	'group.id': 'librd-test',
 * 	'socket.keepalive.enable': true,
 * 	'enable.auto.commit': false
 * }, {}, { topics: [ 'test' ] });
 *
 * @param {object} conf - Key value pairs to configure the consumer
 * @param {object} topicConf - Key value pairs to create a default
 * topic configuration
 * @param {object} streamOptions - Stream options
 * @param {array} streamOptions.topics - Array of topics to subscribe to.
 * @return {KafkaConsumerStream} - Readable stream that receives messages
 * when new ones become available.
 */
KafkaConsumer.createReadStream = function(conf, topicConf, streamOptions) {
  var consumer = new KafkaConsumer(conf, topicConf);
  return new KafkaConsumerStream(consumer, streamOptions);
};

/**
 * Get a current list of the committed offsets per topic partition
 *
 * Returns an array of objects in the form of a topic partition list
 *
 * @param {TopicPartition[]} toppars - Topic partition list to query committed
 * offsets for. Defaults to the current assignment
 * @param  {number} timeout - Number of ms to block before calling back
 * and erroring
 * @param  {Function} cb - Callback method to execute when finished or timed
 * out
 * @return {Client} - Returns itself
 */
KafkaConsumer.prototype.committed = function(toppars, timeout, cb) {
  // We want to be backwards compatible here, and the previous version of
  // this function took two arguments

  // If CB is not set, shift to backwards compatible version
  if (!cb) {
    cb = arguments[1];
    timeout = arguments[0];
    toppars = this.assignments();
  } else {
    toppars = toppars || this.assignments();
  }

  this._client.committed(toppars, timeout, function(err, topicPartitions) {
    if (err) {
      cb(LibrdKafkaError.create(err));
      return;
    }

    cb(null, topicPartitions);
  });
  return this;
};

/**
 * Seek consumer for topic+partition to offset which is either an absolute or
 * logical offset.
 *
 * Does not return anything, as it is asynchronous. There are special cases
 * with the timeout parameter. The consumer must have previously been assigned
 * to topics and partitions that seek seeks to seek.
 *
 * @example
 * consumer.seek({ topic: 'topic', partition: 0, offset: 1000 }, 0, function(err) {
 *   if (err) {
 *
 *   }
 * });
 *
 * @param {TopicPartition} toppar - Topic partition to seek.
 * @param  {number} timeout - Number of ms to block before calling back
 * and erroring. If the parameter is null or 0, the call will not wait
 * for the seek to be performed. Essentially, it will happen in the background
 * with no notification
 * @param  {Function} cb - Callback method to execute when finished or timed
 * out. If the seek timed out, the internal state of the consumer is unknown.
 * @return {Client} - Returns itself
 */
KafkaConsumer.prototype.seek = function(toppar, timeout, cb) {
  this._client.seek(TopicPartition.create(toppar), timeout, function(err) {
    if (err) {
      cb(LibrdKafkaError.create(err));
      return;
    }

    cb();
  });
  return this;
};

/**
 * Assign the consumer specific partitions and topics. Used for
 * eager (non-cooperative) rebalancing.
 *
 * @param {array} assignments - Assignments array. Should contain
 * objects with topic and partition set.
 * @return {Client} - Returns itself
 * @sa KafkaConsumer::incrementalAssign
 */

KafkaConsumer.prototype.assign = function(assignments) {
  this._client.assign(TopicPartition.map(assignments));
  return this;
};

/**
 * Unassign the consumer from its assigned partitions and topics.Used for
 * eager (non-cooperative) rebalancing.
 *
 * @return {Client} - Returns itself
 * @sa KafkaConsumer::incrementalUnassign
 */

KafkaConsumer.prototype.unassign = function() {
  this._client.unassign();
  return this;
};

/**
 * Assign the consumer specific partitions and topics. Used for
 * cooperative rebalancing.
 *
 * @param {array} assignments - Assignments array. Should contain
 * objects with topic and partition set. Assignments are additive.
 * @return {Client} - Returns itself
 * @sa KafkaConsumer::assign
 */
KafkaConsumer.prototype.incrementalAssign = function(assignments) {
  this._client.incrementalAssign(TopicPartition.map(assignments));
  return this;
};

/**
 * Unassign the consumer specific partitions and topics. Used for
 * cooperative rebalancing.
 *
 * @param {array} assignments - Assignments array. Should contain
 * objects with topic and partition set. Assignments are subtractive.
 * @return {Client} - Returns itself
 * @sa KafkaConsumer::unassign
 */
KafkaConsumer.prototype.incrementalUnassign = function(assignments) {
  this._client.incrementalUnassign(TopicPartition.map(assignments));
  return this;
};

/**
 * Get the assignments for the consumer
 *
 * @return {array} assignments - Array of topic partitions
 */

KafkaConsumer.prototype.assignments = function() {
  return this._errorWrap(this._client.assignments(), true);
};

/**
 * Is current assignment in rebalance callback lost?
 *
 * @note This method should only be called from within the rebalance callback
 * when partitions are revoked.
 *
 * @return {boolean} true if assignment was lost
 */

KafkaConsumer.prototype.assignmentLost = function() {
  return this._client.assignmentLost();
};

/**
 * Get the type of rebalance protocol used in the consumer group.
 *
 * @returns "NONE" (if not in a group yet), "COOPERATIVE" or "EAGER".
 */
KafkaConsumer.prototype.rebalanceProtocol = function() {
  return this._client.rebalanceProtocol();
};

/**
 * Subscribe to an array of topics (synchronously).
 *
 * This operation is pretty fast because it just sets
 * an assignment in librdkafka. This is the recommended
 * way to deal with subscriptions in a situation where you
 * will be reading across multiple files or as part of
 * your configure-time initialization.
 *
 * This is also a good way to do it for streams.
 *
 * @param  {array} topics - An array of topics to listen to
 * @throws - Throws when an error code came back from native land
 * @return {KafkaConsumer} - Returns itself.
 */
KafkaConsumer.prototype.subscribe = function(topics) {
  // Will throw if it is a bad error.
  this._errorWrap(this._client.subscribe(topics));
  this.emit('subscribed', topics);
  return this;
};

/**
 * Get the current subscription of the KafkaConsumer
 *
 * Get a list of subscribed topics. Should generally match what you
 * passed on via subscribe
 *
 * @see KafkaConsumer::subscribe
 * @throws - Throws when an error code came back from native land
 * @return {array} - Array of strings to show the current assignment
 */
KafkaConsumer.prototype.subscription = function() {
  return this._errorWrap(this._client.subscription(), true);
};

/**
 * Get the current offset position of the KafkaConsumer
 *
 * Returns a list of RdKafka::TopicPartitions on success, or throws
 * an error on failure
 *
 * @param {TopicPartition[]} toppars - List of topic partitions to query
 * position for. Defaults to the current assignment
 * @throws - Throws when an error code came back from native land
 * @return {array} - TopicPartition array. Each item is an object with
 * an offset, topic, and partition
 */
KafkaConsumer.prototype.position = function(toppars) {
  if (!toppars) {
    toppars = this.assignments();
  }
  return this._errorWrap(this._client.position(toppars), true);
};

/**
 * Unsubscribe from all currently subscribed topics
 *
 * Before you subscribe to new topics you need to unsubscribe
 * from the old ones, if there is an active subscription.
 * Otherwise, you will get an error because there is an
 * existing subscription.
 *
 * @throws - Throws when an error code comes back from native land
 * @return {KafkaConsumer} - Returns itself.
 */
KafkaConsumer.prototype.unsubscribe = function() {
  this._errorWrap(this._client.unsubscribe());
  this.emit('unsubscribed', []);
  // Backwards compatible change
  this.emit('unsubscribe', []);
  return this;
};

/**
 * Read a number of messages from Kafka.
 *
 * This method is similar to the main one, except that it reads a number
 * of messages before calling back. This may get better performance than
 * reading a single message each time in stream implementations.
 *
 * This will keep going until it gets ERR__PARTITION_EOF or ERR__TIMED_OUT
 * so the array may not be the same size you ask for. The size is advisory,
 * but we will not exceed it.
 *
 * @param {number} size - Number of messages to read
 * @param {KafkaConsumer~readCallback} cb - Callback to return when work is done.
 *//**
 * Read messages from Kafka as fast as possible
 *
 * This method keeps a background thread running to fetch the messages
 * as quickly as it can, sleeping only in between EOF and broker timeouts.
 *
 * Use this to get the maximum read performance if you don't care about the
 * stream backpressure.
 * @param {KafkaConsumer~readCallback} cb - Callback to return when a message
 * is fetched.
 */
KafkaConsumer.prototype.consume = function(number, cb) {
  var timeoutMs = this._consumeTimeout !== undefined ? this._consumeTimeout : DEFAULT_CONSUME_TIME_OUT;

  if ((number && typeof number === 'number') || (number && cb)) {

    if (cb === undefined) {
      cb = function() {};
    } else if (typeof cb !== 'function') {
      throw new TypeError('Callback must be a function');
    }

    this._consumeNum(timeoutMs, number, cb);
  } else {

    // See https://github.com/confluentinc/confluent-kafka-javascript/issues/220
    // Docs specify just a callback can be provided but really we needed
    // a fallback to the number argument
    // @deprecated
    if (cb === undefined) {
      if (typeof number === 'function') {
        cb = number;
      } else {
        cb = function() {};
      }
    }

    this._consumeLoop(timeoutMs, cb);
  }
};

/**
 * Open a background thread and keep getting messages as fast
 * as we can. Should not be called directly, and instead should
 * be called using consume.
 *
 * @private
 * @see consume
 */
KafkaConsumer.prototype._consumeLoop = function(timeoutMs, cb) {
  var self = this;
  var retryReadInterval = this._consumeLoopTimeoutDelay;
  self._client.consumeLoop(timeoutMs, retryReadInterval, function readCallback(err, message, eofEvent, warning) {

    if (err) {
      // A few different types of errors here
      // but the two we do NOT care about are
      // time outs at least now
      // Broker no more messages will also not come here
      cb(LibrdKafkaError.create(err));
    } else if (eofEvent) {
      self.emit('partition.eof', eofEvent);
    } else if (warning) {
      self.emit('warning', LibrdKafkaError.create(warning));
    } else {
      /**
       * Data event. called whenever a message is received.
       *
       * @event KafkaConsumer#data
       * @type {KafkaConsumer~Message}
       */
      self.emit('data', message);
      cb(err, message);
    }
  });

};

/**
 * Consume a number of messages and wrap in a try catch with
 * proper error reporting. Should not be called directly,
 * and instead should be called using consume.
 *
 * @private
 * @see consume
 */
KafkaConsumer.prototype._consumeNum = function(timeoutMs, numMessages, cb) {
  var self = this;

  this._client.consume(timeoutMs, numMessages, this._consumeIsTimeoutOnlyForFirstMessage, function(err, messages, eofEvents) {
    if (err) {
      err = LibrdKafkaError.create(err);
      if (cb) {
        cb(err);
      }
      return;
    }

    var currentEofEventsIndex = 0;

    function emitEofEventsFor(messageIndex) {
      while (currentEofEventsIndex < eofEvents.length && eofEvents[currentEofEventsIndex].messageIndex === messageIndex) {
        delete eofEvents[currentEofEventsIndex].messageIndex;
        self.emit('partition.eof', eofEvents[currentEofEventsIndex]);
        ++currentEofEventsIndex;
      }
    }

    emitEofEventsFor(-1);

    for (var i = 0; i < messages.length; i++) {
      self.emit('data', messages[i]);
      emitEofEventsFor(i);
    }

    emitEofEventsFor(messages.length);

    if (cb) {
      cb(null, messages);
    }

  });

};

/**
 * This callback returns the message read from Kafka.
 *
 * @callback KafkaConsumer~readCallback
 * @param {LibrdKafkaError} err - An error, if one occurred while reading
 * the data.
 * @param {KafkaConsumer~Message} message
 */

/**
 * Commit a topic partition or all topic partitions that have been read
 *
 * If you provide a topic partition, it will commit that. Otherwise,
 * it will commit all read offsets for all topic partitions.
 *
 * @param {object|array|null} - Topic partition object to commit, list of topic
 * partitions, or null if you want to commit all read offsets.
 * @throws When commit returns a non 0 error code
 *
 * @return {KafkaConsumer} - returns itself.
 */
KafkaConsumer.prototype.commit = function(topicPartition) {
  this._errorWrap(this._client.commit(topicPartition), true);
  return this;
};

/**
 * Commit a message
 *
 * This is basically a convenience method to map commit properly. We need to
 * add one to the offset in this case
 *
 * @param {object} - Message object to commit
 * @throws When commit returns a non 0 error code
 *
 * @return {KafkaConsumer} - returns itself.
 */
KafkaConsumer.prototype.commitMessage = function(msg) {
  var topicPartition = {
    topic: msg.topic,
    partition: msg.partition,
    offset: msg.offset + 1,
    leaderEpoch: msg.leaderEpoch
  };

  this._errorWrap(this._client.commit(topicPartition), true);
  return this;
};

/**
 * Commit a topic partition (or all topic partitions) synchronously
 *
 * @param {object|array|null} - Topic partition object to commit, list of topic
 * partitions, or null if you want to commit all read offsets.
 * @throws {LibrdKafkaError} - if the commit fails
 *
 * @return {KafkaConsumer} - returns itself.
 */
KafkaConsumer.prototype.commitSync = function(topicPartition) {
  this._errorWrap(this._client.commitSync(topicPartition), true);
  return this;
};

/**
 * Commit a message synchronously
 *
 * @see KafkaConsumer#commitMessageSync
 * @param  {object} msg - A message object to commit.
 *
 * @throws {LibrdKafkaError} - if the commit fails
 *
 * @return {KafkaConsumer} - returns itself.
 */
KafkaConsumer.prototype.commitMessageSync = function(msg) {
  var topicPartition = {
    topic: msg.topic,
    partition: msg.partition,
    offset: msg.offset + 1,
    leaderEpoch: msg.leaderEpoch,
  };

  this._errorWrap(this._client.commitSync(topicPartition), true);
  return this;
};

/**
 * Commits a list of offsets per topic partition, using provided callback.
 *
 * @param {TopicPartition[]} toppars - Topic partition list to commit
 * offsets for. Defaults to the current assignment
 * @param  {Function} cb - Callback method to execute when finished
 * @return {Client} - Returns itself
 */
KafkaConsumer.prototype.commitCb = function(toppars, cb) {
  this._client.commitCb(toppars, function(err) {
    if (err) {
      cb(LibrdKafkaError.create(err));
      return;
    }

    cb(null);
  });
  return this;
};

/**
 * Get last known offsets from the client.
 *
 * The low offset is updated periodically (if statistics.interval.ms is set)
 * while the high offset is updated on each fetched message set from the
 * broker.
 *
 * If there is no cached offset (either low or high, or both), then this will
 * throw an error.
 *
 * @param {string} topic - Topic to recieve offsets from.
 * @param {number} partition - Partition of the provided topic to recieve offsets from
 * @return {Client~watermarkOffsets} - Returns an object with a high and low property, specifying
 * the high and low offsets for the topic partition
 * @throws {LibrdKafkaError} - Throws when there is no offset stored
 */
KafkaConsumer.prototype.getWatermarkOffsets = function(topic, partition) {
  if (!this.isConnected()) {
    throw new Error('Client is disconnected');
  }

  return this._errorWrap(this._client.getWatermarkOffsets(topic, partition), true);
};

/**
 * Store offset for topic partition.
 *
 * The offset will be committed (written) to the offset store according to the auto commit interval,
 * if auto commit is on, or next manual offset if not.
 *
 * enable.auto.offset.store must be set to false to use this API,
 *
 * @see https://github.com/confluentinc/librdkafka/blob/261371dc0edef4cea9e58a076c8e8aa7dc50d452/src-cpp/rdkafkacpp.h#L1702
 *
 * @param {Array.<TopicPartition>} topicPartitions - Topic partitions with offsets to store offsets for.
 * @throws {LibrdKafkaError} - Throws when there is no offset stored
 */
KafkaConsumer.prototype.offsetsStore = function(topicPartitions) {
  if (!this.isConnected()) {
    throw new Error('Client is disconnected');
  }

  return this._errorWrap(this._client.offsetsStore(topicPartitions), true);
};

/**
 * Store offset for a single topic partition. Do not use this method.
 * This method is meant for internal use, and the API is not guaranteed to be stable.
 * Use offsetsStore instead.
 *
 * @param {string} topic - Topic to store offset for.
 * @param {number} partition - Partition of the provided topic to store offset for.
 * @param {number} offset - Offset to store.
 * @param {number} leaderEpoch - Leader epoch of the provided offset.
 * @throws {LibrdKafkaError} - Throws when there is no offset stored
 */
KafkaConsumer.prototype._offsetsStoreSingle = function(topic, partition, offset, leaderEpoch) {
  if (!this.isConnected()) {
    throw new Error('Client is disconnected');
  }

  return this._errorWrap(
    this._client.offsetsStoreSingle(topic, partition, offset, leaderEpoch), true);
};

/**
 * Resume consumption for the provided list of partitions.
 *
 * @param {Array.<TopicPartition>} topicPartitions - List of topic partitions to resume consumption on.
 * @throws {LibrdKafkaError} - Throws when there is no offset stored
 */
KafkaConsumer.prototype.resume = function(topicPartitions) {
  if (!this.isConnected()) {
    throw new Error('Client is disconnected');
  }

  return this._errorWrap(this._client.resume(topicPartitions), true);
};

/**
 * Pause producing or consumption for the provided list of partitions.
 *
 * @param {Array.<TopicPartition>} topicPartitions - List of topics to pause consumption on.
 * @throws {LibrdKafkaError} - Throws when there is no offset stored
 */
KafkaConsumer.prototype.pause = function(topicPartitions) {
  if (!this.isConnected()) {
    throw new Error('Client is disconnected');
  }

  return this._errorWrap(this._client.pause(topicPartitions), true);
};

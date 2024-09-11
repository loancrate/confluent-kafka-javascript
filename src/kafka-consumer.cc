/*
 * confluent-kafka-javascript - Node.js wrapper  for RdKafka C/C++ library
 *
 * Copyright (c) 2016-2023 Blizzard Entertainment
 *           (c) 2023 Confluent, Inc.
 *
 * This software may be modified and distributed under the terms
 * of the MIT license.  See the LICENSE.txt file for details.
 */

#include <iostream>
#include <string>
#include <vector>

#include "src/kafka-consumer.h"
#include "src/workers.h"

using Nan::FunctionCallbackInfo;

namespace NodeKafka {

/**
 * @brief KafkaConsumer v8 wrapped object.
 *
 * Specializes the connection to wrap a consumer object through compositional
 * inheritence. Establishes its prototype in node through `Init`
 *
 * @sa RdKafka::Handle
 * @sa NodeKafka::Client
 */

KafkaConsumer::KafkaConsumer(Conf* gconfig, Conf* tconfig):
  Connection(gconfig, tconfig) {
    std::string errstr;

    if (m_tconfig)
      m_gconfig->set("default_topic_conf", m_tconfig, errstr);

    m_consume_loop = nullptr;
  }

KafkaConsumer::~KafkaConsumer() {
  // We only want to run this if it hasn't been run already
  Disconnect();
}

Baton KafkaConsumer::Connect() {
  if (IsConnected()) {
    return Baton(RdKafka::ERR_NO_ERROR);
  }

  Baton baton = setupSaslOAuthBearerConfig();
  if (baton.err() != RdKafka::ERR_NO_ERROR) {
    return baton;
  }

  std::string errstr;
  {
    scoped_shared_write_lock lock(m_connection_lock);
    m_consumer = RdKafka::KafkaConsumer::create(m_gconfig, errstr);
    m_client = m_consumer;
  }

  if (!m_client || !errstr.empty()) {
    return Baton(RdKafka::ERR__STATE, errstr);
  }

  /* Set the client name at the first possible opportunity for logging. */
  m_event_cb.dispatcher.SetClientName(m_client->name());

  baton = setupSaslOAuthBearerBackgroundQueue();
  if (baton.err() != RdKafka::ERR_NO_ERROR) {
    return baton;
  }

  if (m_partitions.size() > 0) {
    m_client->resume(m_partitions);
  }

  return Baton(RdKafka::ERR_NO_ERROR);
}

void KafkaConsumer::ActivateDispatchers() {
  // Listen to global config
  m_gconfig->listen();

  // Listen to non global config
  // tconfig->listen();

  // This should be refactored to config based management
  m_event_cb.dispatcher.Activate();
}

Baton KafkaConsumer::Disconnect() {
  // Only close client if it is connected
  RdKafka::ErrorCode err = RdKafka::ERR_NO_ERROR;

  if (IsConnected()) {
    m_is_closing = true;
    {
      scoped_shared_write_lock lock(m_connection_lock);

      err = m_consumer->close();

      delete m_client;
      m_client = NULL;
      m_consumer = nullptr;
    }
  }

  m_is_closing = false;

  return Baton(err);
}

void KafkaConsumer::DeactivateDispatchers() {
  // Stop listening to the config dispatchers
  m_gconfig->stop();

  // Also this one
  m_event_cb.dispatcher.Deactivate();
}

bool KafkaConsumer::IsSubscribed() {
  if (!IsConnected()) {
    return false;
  }

  if (!m_is_subscribed) {
    return false;
  }

  return true;
}


bool KafkaConsumer::HasAssignedPartitions() {
  return !m_partitions.empty();
}

int KafkaConsumer::AssignedPartitionCount() {
  return m_partition_cnt;
}

Baton KafkaConsumer::GetWatermarkOffsets(
  std::string topic_name, int32_t partition,
  int64_t* low_offset, int64_t* high_offset) {
  // Check if we are connected first

  RdKafka::ErrorCode err;

  if (IsConnected()) {
    scoped_shared_read_lock lock(m_connection_lock);
    if (IsConnected()) {
      // Always send true - we
      err = m_client->get_watermark_offsets(topic_name, partition,
        low_offset, high_offset);
    } else {
      err = RdKafka::ERR__STATE;
    }
  } else {
    err = RdKafka::ERR__STATE;
  }

  return Baton(err);
}

void KafkaConsumer::part_list_print(const std::vector<RdKafka::TopicPartition*> &partitions) {  // NOLINT
  for (unsigned int i = 0 ; i < partitions.size() ; i++)
    std::cerr << partitions[i]->topic() <<
      "[" << partitions[i]->partition() << "], ";
  std::cerr << std::endl;
}

Baton KafkaConsumer::Assign(std::vector<RdKafka::TopicPartition*> partitions) {
  if (!IsConnected()) {
    return Baton(RdKafka::ERR__STATE, "KafkaConsumer is disconnected");
  }


  RdKafka::ErrorCode errcode = m_consumer->assign(partitions);

  if (errcode == RdKafka::ERR_NO_ERROR) {
    m_partition_cnt = partitions.size();
    m_partitions.swap(partitions);
  }

  // Destroy the partitions: Either we're using them (and partitions
  // is now our old vector), or we're not using it as there was an
  // error.
  RdKafka::TopicPartition::destroy(partitions);

  return Baton(errcode);
}

Baton KafkaConsumer::Unassign() {
  if (!IsClosing() && !IsConnected()) {
    return Baton(RdKafka::ERR__STATE);
  }

  RdKafka::ErrorCode errcode = m_consumer->unassign();

  if (errcode != RdKafka::ERR_NO_ERROR) {
    return Baton(errcode);
  }

  // Destroy the old list of partitions since we are no longer using it
  RdKafka::TopicPartition::destroy(m_partitions);

  m_partition_cnt = 0;

  return Baton(RdKafka::ERR_NO_ERROR);
}

Baton KafkaConsumer::IncrementalAssign(
  std::vector<RdKafka::TopicPartition*> partitions) {
  if (!IsConnected()) {
    return Baton(RdKafka::ERR__STATE, "KafkaConsumer is disconnected");
  }

  RdKafka::Error* error = m_consumer->incremental_assign(partitions);

  if (error == NULL) {
    m_partition_cnt += partitions.size();
    // We assume here that there are no duplicate assigns and just transfer.
    m_partitions.insert(m_partitions.end(), partitions.begin(), partitions.end()); // NOLINT
  } else {
    // If we're in error, destroy it, otherwise, don't (since we're using them).
    RdKafka::TopicPartition::destroy(partitions);
  }

  return rdkafkaErrorToBaton(error);
}

Baton KafkaConsumer::IncrementalUnassign(
  std::vector<RdKafka::TopicPartition*> partitions) {
  if (!IsClosing() && !IsConnected()) {
    return Baton(RdKafka::ERR__STATE);
  }

  RdKafka::Error* error = m_consumer->incremental_unassign(partitions);

  std::vector<RdKafka::TopicPartition*> delete_partitions;

  if (error == NULL) {
    // For now, use two for loops. Make more efficient if needed later.
    for (unsigned int i = 0; i < partitions.size(); i++) {
      for (unsigned int j = 0; j < m_partitions.size(); j++) {
        if (partitions[i]->partition() == m_partitions[j]->partition() &&
            partitions[i]->topic() == m_partitions[j]->topic()) {
          delete_partitions.push_back(m_partitions[j]);
          m_partitions.erase(m_partitions.begin() + j);
          m_partition_cnt--;
          break;
        }
      }
    }
  }

  // Destroy the old list of partitions since we are no longer using it
  RdKafka::TopicPartition::destroy(delete_partitions);

  // Destroy the partition args since those are only used to lookup the
  // partitions that needed to be deleted.
  RdKafka::TopicPartition::destroy(partitions);

  return rdkafkaErrorToBaton(error);
}

Baton KafkaConsumer::Commit(std::vector<RdKafka::TopicPartition*> toppars) {
  if (!IsConnected()) {
    return Baton(RdKafka::ERR__STATE);
  }

  RdKafka::ErrorCode err = m_consumer->commitAsync(toppars);

  return Baton(err);
}

Baton KafkaConsumer::Commit(RdKafka::TopicPartition * toppar) {
  if (!IsConnected()) {
    return Baton(RdKafka::ERR__STATE, "KafkaConsumer is not connected");
  }

  // Need to put topic in a vector for it to work
  std::vector<RdKafka::TopicPartition*> offsets = {toppar};
  RdKafka::ErrorCode err = m_consumer->commitAsync(offsets);

  return Baton(err);
}

Baton KafkaConsumer::Commit() {
  // sets an error message
  if (!IsConnected()) {
    return Baton(RdKafka::ERR__STATE, "KafkaConsumer is not connected");
  }

  RdKafka::ErrorCode err = m_consumer->commitAsync();

  return Baton(err);
}

// Synchronous commit events
Baton KafkaConsumer::CommitSync(std::vector<RdKafka::TopicPartition*> toppars) {
  if (!IsConnected()) {
    return Baton(RdKafka::ERR__STATE, "KafkaConsumer is not connected");
  }

  RdKafka::ErrorCode err = m_consumer->commitSync(toppars);
  // RdKafka::TopicPartition::destroy(toppars);

  return Baton(err);
}

Baton KafkaConsumer::CommitSync(RdKafka::TopicPartition * toppar) {
  if (!IsConnected()) {
    return Baton(RdKafka::ERR__STATE);
  }

  // Need to put topic in a vector for it to work
  std::vector<RdKafka::TopicPartition*> offsets = {toppar};
  RdKafka::ErrorCode err = m_consumer->commitSync(offsets);

  return Baton(err);
}

Baton KafkaConsumer::CommitSync() {
  // sets an error message
  if (!IsConnected()) {
    return Baton(RdKafka::ERR__STATE, "KafkaConsumer is not connected");
  }

  RdKafka::ErrorCode err = m_consumer->commitSync();

  return Baton(err);
}

Baton KafkaConsumer::Seek(const RdKafka::TopicPartition &partition, int timeout_ms) {  // NOLINT
  if (!IsConnected()) {
    return Baton(RdKafka::ERR__STATE, "KafkaConsumer is not connected");
  }

  RdKafka::ErrorCode err = m_consumer->seek(partition, timeout_ms);

  return Baton(err);
}

Baton KafkaConsumer::Committed(std::vector<RdKafka::TopicPartition*> &toppars,
  int timeout_ms) {
  if (!IsConnected()) {
    return Baton(RdKafka::ERR__STATE, "KafkaConsumer is not connected");
  }

  RdKafka::ErrorCode err = m_consumer->committed(toppars, timeout_ms);

  return Baton(err);
}

Baton KafkaConsumer::Position(std::vector<RdKafka::TopicPartition*> &toppars) {
  if (!IsConnected()) {
    return Baton(RdKafka::ERR__STATE, "KafkaConsumer is not connected");
  }

  RdKafka::ErrorCode err = m_consumer->position(toppars);

  return Baton(err);
}

Baton KafkaConsumer::Subscription() {
  if (!IsConnected()) {
    return Baton(RdKafka::ERR__STATE, "Consumer is not connected");
  }

  // Needs to be a pointer since we're returning it through the baton
  std::vector<std::string> * topics = new std::vector<std::string>;

  RdKafka::ErrorCode err = m_consumer->subscription(*topics);

  if (err == RdKafka::ErrorCode::ERR_NO_ERROR) {
    // Good to go
    return Baton(topics);
  }

  return Baton(err);
}

Baton KafkaConsumer::Unsubscribe() {
  if (IsConnected() && IsSubscribed()) {
    m_consumer->unsubscribe();
    m_is_subscribed = false;
  }

  return Baton(RdKafka::ERR_NO_ERROR);
}

Baton KafkaConsumer::Pause(std::vector<RdKafka::TopicPartition*> & toppars) {
  if (IsConnected()) {
    RdKafka::ErrorCode err = m_consumer->pause(toppars);
    return Baton(err);
  }

  return Baton(RdKafka::ERR__STATE);
}

Baton KafkaConsumer::Resume(std::vector<RdKafka::TopicPartition*> & toppars) {
  if (IsConnected()) {
    RdKafka::ErrorCode err = m_consumer->resume(toppars);

    return Baton(err);
  }

  return Baton(RdKafka::ERR__STATE);
}

Baton KafkaConsumer::OffsetsStore(
    std::vector<RdKafka::TopicPartition*>& toppars) {  // NOLINT
  if (!IsSubscribed()) { /* IsSubscribed also checks IsConnected */
    return Baton(RdKafka::ERR__STATE);
  }

  RdKafka::ErrorCode err = m_consumer->offsets_store(toppars);

  return Baton(err);
}

Baton KafkaConsumer::Subscribe(std::vector<std::string> topics) {
  if (!IsConnected()) {
    return Baton(RdKafka::ERR__STATE);
  }

  RdKafka::ErrorCode errcode = m_consumer->subscribe(topics);
  if (errcode != RdKafka::ERR_NO_ERROR) {
    return Baton(errcode);
  }

  m_is_subscribed = true;

  return Baton(RdKafka::ERR_NO_ERROR);
}

Baton KafkaConsumer::Consume(int timeout_ms) {
  if (IsConnected()) {
    scoped_shared_read_lock lock(m_connection_lock);
    if (!IsConnected()) {
      return Baton(RdKafka::ERR__STATE, "KafkaConsumer is not connected");
    } else {
      RdKafka::Message * message = m_consumer->consume(timeout_ms);
      RdKafka::ErrorCode response_code = message->err();
      // we want to handle these errors at the call site
      if (response_code != RdKafka::ERR_NO_ERROR &&
         response_code != RdKafka::ERR__PARTITION_EOF &&
         response_code != RdKafka::ERR__TIMED_OUT &&
         response_code != RdKafka::ERR__TIMED_OUT_QUEUE
       ) {
        delete message;
        return Baton(response_code);
      }

      return Baton(message);
    }
  } else {
    return Baton(RdKafka::ERR__STATE, "KafkaConsumer is not connected");
  }
}

Baton KafkaConsumer::RefreshAssignments() {
  if (!IsConnected()) {
    return Baton(RdKafka::ERR__STATE);
  }

  std::vector<RdKafka::TopicPartition*> partition_list;
  RdKafka::ErrorCode err = m_consumer->assignment(partition_list);

  switch (err) {
    case RdKafka::ERR_NO_ERROR:
      m_partition_cnt = partition_list.size();
      m_partitions.swap(partition_list);

      // These are pointers so we need to delete them somewhere.
      // Do it here because we're only going to convert when we're ready
      // to return to v8.
      RdKafka::TopicPartition::destroy(partition_list);
      return Baton(RdKafka::ERR_NO_ERROR);
    break;
    default:
      return Baton(err);
    break;
  }
}

std::string KafkaConsumer::RebalanceProtocol() {
  if (!IsConnected()) {
    return std::string("NONE");
  }

  return m_consumer->rebalance_protocol();
}

Nan::Persistent<v8::Function> KafkaConsumer::constructor;

void KafkaConsumer::Init(v8::Local<v8::Object> exports) {
  Nan::HandleScope scope;

  v8::Local<v8::FunctionTemplate> tpl = Nan::New<v8::FunctionTemplate>(New);
  tpl->SetClassName(Nan::New("KafkaConsumer").ToLocalChecked());
  tpl->InstanceTemplate()->SetInternalFieldCount(1);

  /*
   * Lifecycle events inherited from NodeKafka::Connection
   *
   * @sa NodeKafka::Connection
   */

  Nan::SetPrototypeMethod(tpl, "configureCallbacks", NodeConfigureCallbacks);

  /*
   * @brief Methods to do with establishing state
   */

  Nan::SetPrototypeMethod(tpl, "connect", NodeConnect);
  Nan::SetPrototypeMethod(tpl, "disconnect", NodeDisconnect);
  Nan::SetPrototypeMethod(tpl, "getMetadata", NodeGetMetadata);
  Nan::SetPrototypeMethod(tpl, "queryWatermarkOffsets", NodeQueryWatermarkOffsets);  // NOLINT
  Nan::SetPrototypeMethod(tpl, "offsetsForTimes", NodeOffsetsForTimes);
  Nan::SetPrototypeMethod(tpl, "getWatermarkOffsets", NodeGetWatermarkOffsets);
  Nan::SetPrototypeMethod(tpl, "setSaslCredentials", NodeSetSaslCredentials);
  Nan::SetPrototypeMethod(tpl, "setOAuthBearerToken", NodeSetOAuthBearerToken);
  Nan::SetPrototypeMethod(tpl, "setOAuthBearerTokenFailure",
                          NodeSetOAuthBearerTokenFailure);

  /*
   * @brief Methods exposed to do with message retrieval
   */
  Nan::SetPrototypeMethod(tpl, "subscription", NodeSubscription);
  Nan::SetPrototypeMethod(tpl, "subscribe", NodeSubscribe);
  Nan::SetPrototypeMethod(tpl, "unsubscribe", NodeUnsubscribe);
  Nan::SetPrototypeMethod(tpl, "consumeLoop", NodeConsumeLoop);
  Nan::SetPrototypeMethod(tpl, "consume", NodeConsume);
  Nan::SetPrototypeMethod(tpl, "seek", NodeSeek);

  /**
   * @brief Pausing and resuming
   */
  Nan::SetPrototypeMethod(tpl, "pause", NodePause);
  Nan::SetPrototypeMethod(tpl, "resume", NodeResume);

  /*
   * @brief Methods to do with partition assignment / rebalancing
   */

  Nan::SetPrototypeMethod(tpl, "committed", NodeCommitted);
  Nan::SetPrototypeMethod(tpl, "position", NodePosition);
  Nan::SetPrototypeMethod(tpl, "assign", NodeAssign);
  Nan::SetPrototypeMethod(tpl, "unassign", NodeUnassign);
  Nan::SetPrototypeMethod(tpl, "incrementalAssign", NodeIncrementalAssign);
  Nan::SetPrototypeMethod(tpl, "incrementalUnassign", NodeIncrementalUnassign);
  Nan::SetPrototypeMethod(tpl, "assignments", NodeAssignments);
  Nan::SetPrototypeMethod(tpl, "rebalanceProtocol", NodeRebalanceProtocol);

  Nan::SetPrototypeMethod(tpl, "commit", NodeCommit);
  Nan::SetPrototypeMethod(tpl, "commitSync", NodeCommitSync);
  Nan::SetPrototypeMethod(tpl, "commitCb", NodeCommitCb);
  Nan::SetPrototypeMethod(tpl, "offsetsStore", NodeOffsetsStore);
  Nan::SetPrototypeMethod(tpl, "offsetsStoreSingle", NodeOffsetsStoreSingle);

  constructor.Reset((tpl->GetFunction(Nan::GetCurrentContext()))
    .ToLocalChecked());
  Nan::Set(exports, Nan::New("KafkaConsumer").ToLocalChecked(),
    (tpl->GetFunction(Nan::GetCurrentContext())).ToLocalChecked());
}

void KafkaConsumer::New(const Nan::FunctionCallbackInfo<v8::Value>& info) {
  if (!info.IsConstructCall()) {
    return Nan::ThrowError("non-constructor invocation not supported");
  }

  if (info.Length() < 2) {
    return Nan::ThrowError("You must supply global and topic configuration");
  }

  if (!info[0]->IsObject()) {
    return Nan::ThrowError("Global configuration data must be specified");
  }

  std::string errstr;

  Conf* gconfig =
    Conf::create(RdKafka::Conf::CONF_GLOBAL,
      (info[0]->ToObject(Nan::GetCurrentContext())).ToLocalChecked(), errstr);

  if (!gconfig) {
    return Nan::ThrowError(errstr.c_str());
  }

  // If tconfig isn't set, then just let us pick properties from gconf.
  Conf* tconfig = nullptr;
  if (info[1]->IsObject()) {
    tconfig = Conf::create(RdKafka::Conf::CONF_TOPIC,
      (info[1]->ToObject(Nan::GetCurrentContext())).ToLocalChecked(), errstr);

    if (!tconfig) {
      delete gconfig;
      return Nan::ThrowError(errstr.c_str());
    }
  }

  // TODO: fix this - this memory is leaked.
  KafkaConsumer* consumer = new KafkaConsumer(gconfig, tconfig);

  // Wrap it
  consumer->Wrap(info.This());

  // Then there is some weird initialization that happens
  // basically it sets the configuration data
  // we don't need to do that because we lazy load it

  info.GetReturnValue().Set(info.This());
}

v8::Local<v8::Object> KafkaConsumer::NewInstance(v8::Local<v8::Value> arg) {
  Nan::EscapableHandleScope scope;

  const unsigned argc = 1;

  v8::Local<v8::Value> argv[argc] = { arg };
  v8::Local<v8::Function> cons = Nan::New<v8::Function>(constructor);
  v8::Local<v8::Object> instance =
    Nan::NewInstance(cons, argc, argv).ToLocalChecked();

  return scope.Escape(instance);
}

/* Node exposed methods */

NAN_METHOD(KafkaConsumer::NodeCommitted) {
  Nan::HandleScope scope;

  if (info.Length() < 3 || !info[0]->IsArray()) {
    // Just throw an exception
    return Nan::ThrowError("Need to specify an array of topic partitions");
  }

  std::vector<RdKafka::TopicPartition *> toppars =
    Conversion::TopicPartition::FromV8Array(info[0].As<v8::Array>());

  int timeout_ms;
  Nan::Maybe<uint32_t> maybeTimeout =
    Nan::To<uint32_t>(info[1].As<v8::Number>());

  if (maybeTimeout.IsNothing()) {
    timeout_ms = 1000;
  } else {
    timeout_ms = static_cast<int>(maybeTimeout.FromJust());
  }

  v8::Local<v8::Function> cb = info[2].As<v8::Function>();
  Nan::Callback *callback = new Nan::Callback(cb);

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  Nan::AsyncQueueWorker(
    new Workers::KafkaConsumerCommitted(callback, consumer,
      toppars, timeout_ms));

  info.GetReturnValue().Set(Nan::Null());
}

NAN_METHOD(KafkaConsumer::NodeSubscription) {
  Nan::HandleScope scope;

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  Baton b = consumer->Subscription();

  if (b.err() != RdKafka::ErrorCode::ERR_NO_ERROR) {
    // Let the JS library throw if we need to so the error can be more rich
    int error_code = static_cast<int>(b.err());
    return info.GetReturnValue().Set(Nan::New<v8::Number>(error_code));
  }

  std::vector<std::string> * topics = b.data<std::vector<std::string>*>();

  info.GetReturnValue().Set(Conversion::Util::ToV8Array(*topics));

  delete topics;
}

NAN_METHOD(KafkaConsumer::NodePosition) {
  Nan::HandleScope scope;

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  if (info.Length() < 1 || !info[0]->IsArray()) {
    // Just throw an exception
    return Nan::ThrowError("Need to specify an array of topic partitions");
  }

  std::vector<RdKafka::TopicPartition *> toppars =
    Conversion::TopicPartition::FromV8Array(info[0].As<v8::Array>());

  Baton b = consumer->Position(toppars);

  if (b.err() != RdKafka::ErrorCode::ERR_NO_ERROR) {
    // Let the JS library throw if we need to so the error can be more rich
    int error_code = static_cast<int>(b.err());
    return info.GetReturnValue().Set(Nan::New<v8::Number>(error_code));
  }

  info.GetReturnValue().Set(
    Conversion::TopicPartition::ToV8Array(toppars));

  // Delete the underlying topic partitions
  RdKafka::TopicPartition::destroy(toppars);
}

NAN_METHOD(KafkaConsumer::NodeAssignments) {
  Nan::HandleScope scope;

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  Baton b = consumer->RefreshAssignments();

  if (b.err() != RdKafka::ERR_NO_ERROR) {
    // Let the JS library throw if we need to so the error can be more rich
    int error_code = static_cast<int>(b.err());
    return info.GetReturnValue().Set(Nan::New<v8::Number>(error_code));
  }

  info.GetReturnValue().Set(
    Conversion::TopicPartition::ToV8Array(consumer->m_partitions));
}

NAN_METHOD(KafkaConsumer::NodeRebalanceProtocol) {
  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());
  std::string protocol = consumer->RebalanceProtocol();
  info.GetReturnValue().Set(Nan::New<v8::String>(protocol).ToLocalChecked());
}

NAN_METHOD(KafkaConsumer::NodeAssign) {
  Nan::HandleScope scope;

  if (info.Length() < 1 || !info[0]->IsArray()) {
    // Just throw an exception
    return Nan::ThrowError("Need to specify an array of partitions");
  }

  v8::Local<v8::Array> partitions = info[0].As<v8::Array>();
  std::vector<RdKafka::TopicPartition*> topic_partitions;

  for (unsigned int i = 0; i < partitions->Length(); ++i) {
    v8::Local<v8::Value> partition_obj_value;
    if (!(
          Nan::Get(partitions, i).ToLocal(&partition_obj_value) &&
          partition_obj_value->IsObject())) {
      Nan::ThrowError("Must pass topic-partition objects");
    }

    v8::Local<v8::Object> partition_obj = partition_obj_value.As<v8::Object>();

    // Got the object
    int64_t partition = GetParameter<int64_t>(partition_obj, "partition", -1);
    std::string topic = GetParameter<std::string>(partition_obj, "topic", "");

    if (!topic.empty()) {
      RdKafka::TopicPartition* part;

      if (partition < 0) {
        part = Connection::GetPartition(topic);
      } else {
        part = Connection::GetPartition(topic, partition);
      }

      // Set the default value to offset invalid. If provided, we will not set
      // the offset.
      int64_t offset = GetParameter<int64_t>(
        partition_obj, "offset", RdKafka::Topic::OFFSET_INVALID);
      if (offset != RdKafka::Topic::OFFSET_INVALID) {
        part->set_offset(offset);
      }

      topic_partitions.push_back(part);
    }
  }

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  // Hand over the partitions to the consumer.
  Baton b = consumer->Assign(topic_partitions);

  if (b.err() != RdKafka::ERR_NO_ERROR) {
    Nan::ThrowError(RdKafka::err2str(b.err()).c_str());
  }

  info.GetReturnValue().Set(Nan::True());
}

NAN_METHOD(KafkaConsumer::NodeUnassign) {
  Nan::HandleScope scope;

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());


  if (!consumer->IsClosing() && !consumer->IsConnected()) {
    Nan::ThrowError("KafkaConsumer is disconnected");
    return;
  }

  Baton b = consumer->Unassign();

  if (b.err() != RdKafka::ERR_NO_ERROR) {
    Nan::ThrowError(RdKafka::err2str(b.err()).c_str());
  }

  info.GetReturnValue().Set(Nan::True());
}

NAN_METHOD(KafkaConsumer::NodeIncrementalAssign) {
  Nan::HandleScope scope;

  if (info.Length() < 1 || !info[0]->IsArray()) {
    // Just throw an exception
    return Nan::ThrowError("Need to specify an array of partitions");
  }

  v8::Local<v8::Array> partitions = info[0].As<v8::Array>();
  std::vector<RdKafka::TopicPartition*> topic_partitions;

  for (unsigned int i = 0; i < partitions->Length(); ++i) {
    v8::Local<v8::Value> partition_obj_value;
    if (!(
          Nan::Get(partitions, i).ToLocal(&partition_obj_value) &&
          partition_obj_value->IsObject())) {
      Nan::ThrowError("Must pass topic-partition objects");
    }

    v8::Local<v8::Object> partition_obj = partition_obj_value.As<v8::Object>();

    // Got the object
    int64_t partition = GetParameter<int64_t>(partition_obj, "partition", -1);
    std::string topic = GetParameter<std::string>(partition_obj, "topic", "");

    if (!topic.empty()) {
      RdKafka::TopicPartition* part;

      if (partition < 0) {
        part = Connection::GetPartition(topic);
      } else {
        part = Connection::GetPartition(topic, partition);
      }

      // Set the default value to offset invalid. If provided, we will not set
      // the offset.
      int64_t offset = GetParameter<int64_t>(
        partition_obj, "offset", RdKafka::Topic::OFFSET_INVALID);
      if (offset != RdKafka::Topic::OFFSET_INVALID) {
        part->set_offset(offset);
      }

      topic_partitions.push_back(part);
    }
  }

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  // Hand over the partitions to the consumer.
  Baton b = consumer->IncrementalAssign(topic_partitions);

  if (b.err() != RdKafka::ERR_NO_ERROR) {
    v8::Local<v8::Value> errorObject = b.ToObject();
    Nan::ThrowError(errorObject);
  }

  info.GetReturnValue().Set(Nan::True());
}

NAN_METHOD(KafkaConsumer::NodeIncrementalUnassign) {
  Nan::HandleScope scope;

  if (info.Length() < 1 || !info[0]->IsArray()) {
    // Just throw an exception
    return Nan::ThrowError("Need to specify an array of partitions");
  }

  v8::Local<v8::Array> partitions = info[0].As<v8::Array>();
  std::vector<RdKafka::TopicPartition*> topic_partitions;

  for (unsigned int i = 0; i < partitions->Length(); ++i) {
    v8::Local<v8::Value> partition_obj_value;
    if (!(
          Nan::Get(partitions, i).ToLocal(&partition_obj_value) &&
          partition_obj_value->IsObject())) {
      Nan::ThrowError("Must pass topic-partition objects");
    }

    v8::Local<v8::Object> partition_obj = partition_obj_value.As<v8::Object>();

    // Got the object
    int64_t partition = GetParameter<int64_t>(partition_obj, "partition", -1);
    std::string topic = GetParameter<std::string>(partition_obj, "topic", "");

    if (!topic.empty()) {
      RdKafka::TopicPartition* part;

      if (partition < 0) {
        part = Connection::GetPartition(topic);
      } else {
        part = Connection::GetPartition(topic, partition);
      }

      // Set the default value to offset invalid. If provided, we will not set
      // the offset.
      int64_t offset = GetParameter<int64_t>(
        partition_obj, "offset", RdKafka::Topic::OFFSET_INVALID);
      if (offset != RdKafka::Topic::OFFSET_INVALID) {
        part->set_offset(offset);
      }

      topic_partitions.push_back(part);
    }
  }

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  // Hand over the partitions to the consumer.
  Baton b = consumer->IncrementalUnassign(topic_partitions);

  if (b.err() != RdKafka::ERR_NO_ERROR) {
    v8::Local<v8::Value> errorObject = b.ToObject();
    Nan::ThrowError(errorObject);
  }

  info.GetReturnValue().Set(Nan::True());
}


NAN_METHOD(KafkaConsumer::NodeUnsubscribe) {
  Nan::HandleScope scope;

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  Baton b = consumer->Unsubscribe();

  info.GetReturnValue().Set(Nan::New<v8::Number>(static_cast<int>(b.err())));
}

NAN_METHOD(KafkaConsumer::NodeCommit) {
  Nan::HandleScope scope;
  int error_code;

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  if (!consumer->IsConnected()) {
    Nan::ThrowError("KafkaConsumer is disconnected");
    return;
  }

  if (info[0]->IsNull() || info[0]->IsUndefined()) {
    Baton b = consumer->Commit();
    error_code = static_cast<int>(b.err());
  } else if (info[0]->IsArray()) {
    std::vector<RdKafka::TopicPartition *> toppars =
      Conversion::TopicPartition::FromV8Array(info[0].As<v8::Array>());

    Baton b = consumer->Commit(toppars);
    error_code = static_cast<int>(b.err());

    RdKafka::TopicPartition::destroy(toppars);
  } else if (info[0]->IsObject()) {
    RdKafka::TopicPartition * toppar =
      Conversion::TopicPartition::FromV8Object(info[0].As<v8::Object>());

    if (toppar == NULL) {
      Nan::ThrowError("Invalid topic partition provided");
      return;
    }

    Baton b = consumer->Commit(toppar);
    error_code = static_cast<int>(b.err());

    delete toppar;
  } else {
    Nan::ThrowError("First parameter must be an object or an array");
    return;
  }

  info.GetReturnValue().Set(Nan::New<v8::Number>(error_code));
}

NAN_METHOD(KafkaConsumer::NodeCommitSync) {
  Nan::HandleScope scope;
  int error_code;

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  if (!consumer->IsConnected()) {
    Nan::ThrowError("KafkaConsumer is disconnected");
    return;
  }

  if (info[0]->IsNull() || info[0]->IsUndefined()) {
    Baton b = consumer->CommitSync();
    error_code = static_cast<int>(b.err());
  } else if (info[0]->IsArray()) {
    std::vector<RdKafka::TopicPartition *> toppars =
      Conversion::TopicPartition::FromV8Array(info[0].As<v8::Array>());

    Baton b = consumer->CommitSync(toppars);
    error_code = static_cast<int>(b.err());

    RdKafka::TopicPartition::destroy(toppars);
  } else if (info[0]->IsObject()) {
    RdKafka::TopicPartition * toppar =
      Conversion::TopicPartition::FromV8Object(info[0].As<v8::Object>());

    if (toppar == NULL) {
      Nan::ThrowError("Invalid topic partition provided");
      return;
    }

    Baton b = consumer->CommitSync(toppar);
    error_code = static_cast<int>(b.err());

    delete toppar;
  } else {
    Nan::ThrowError("First parameter must be an object or an array");
    return;
  }

  info.GetReturnValue().Set(Nan::New<v8::Number>(error_code));
}

NAN_METHOD(KafkaConsumer::NodeCommitCb) {
  Nan::HandleScope scope;
  int error_code;
  std::optional<std::vector<RdKafka::TopicPartition *>> toppars = std::nullopt;
  Nan::Callback *callback;

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  if (!consumer->IsConnected()) {
    Nan::ThrowError("KafkaConsumer is disconnected");
    return;
  }

  if (info.Length() != 2) {
    Nan::ThrowError("Two arguments are required");
    return;
  }

  if (!(
      (info[0]->IsArray() || info[0]->IsNull()) &&
      info[1]->IsFunction())) {
    Nan::ThrowError(
      "First argument should be an array or null and second one a callback");
    return;
  }

  if (info[0]->IsArray()) {
    toppars =
      Conversion::TopicPartition::FromV8Array(info[0].As<v8::Array>());
  }
  callback = new Nan::Callback(info[1].As<v8::Function>());

  Nan::AsyncQueueWorker(
    new Workers::KafkaConsumerCommitCb(callback, consumer,
      toppars));

  info.GetReturnValue().Set(Nan::Null());
}

NAN_METHOD(KafkaConsumer::NodeSubscribe) {
  Nan::HandleScope scope;

  if (info.Length() < 1 || !info[0]->IsArray()) {
    // Just throw an exception
    return Nan::ThrowError("First parameter must be an array");
  }

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  v8::Local<v8::Array> topicsArray = info[0].As<v8::Array>();
  std::vector<std::string> topics =
      Conversion::Util::ToStringVector(topicsArray);

  Baton b = consumer->Subscribe(topics);

  int error_code = static_cast<int>(b.err());
  info.GetReturnValue().Set(Nan::New<v8::Number>(error_code));
}

NAN_METHOD(KafkaConsumer::NodeSeek) {
  Nan::HandleScope scope;

  // If number of parameters is less than 3 (need topic partition, timeout,
  // and callback), we can't call this thing
  if (info.Length() < 3) {
    return Nan::ThrowError("Must provide a topic partition, timeout, and callback");  // NOLINT
  }

  if (!info[0]->IsObject()) {
    return Nan::ThrowError("Topic partition must be an object");
  }

  if (!info[1]->IsNumber() && !info[1]->IsNull()) {
    return Nan::ThrowError("Timeout must be a number.");
  }

  if (!info[2]->IsFunction()) {
    return Nan::ThrowError("Callback must be a function");
  }

  int timeout_ms;
  Nan::Maybe<uint32_t> maybeTimeout =
    Nan::To<uint32_t>(info[1].As<v8::Number>());

  if (maybeTimeout.IsNothing()) {
    timeout_ms = 1000;
  } else {
    timeout_ms = static_cast<int>(maybeTimeout.FromJust());
    // Do not allow timeouts of less than 10. Providing 0 causes segfaults
    // because it makes it asynchronous.
    if (timeout_ms < 10) {
      timeout_ms = 10;
    }
  }

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  const RdKafka::TopicPartition * toppar =
    Conversion::TopicPartition::FromV8Object(info[0].As<v8::Object>());

  if (!toppar) {
    return Nan::ThrowError("Invalid topic partition provided");
  }

  Nan::Callback *callback = new Nan::Callback(info[2].As<v8::Function>());
  Nan::AsyncQueueWorker(
    new Workers::KafkaConsumerSeek(callback, consumer, toppar, timeout_ms));

  info.GetReturnValue().Set(Nan::Null());
}

NAN_METHOD(KafkaConsumer::NodeOffsetsStore) {
  Nan::HandleScope scope;

  // If number of parameters is less than 3 (need topic partition, timeout,
  // and callback), we can't call this thing
  if (info.Length() < 1) {
    return Nan::ThrowError("Must provide a list of topic partitions");
  }

  if (!info[0]->IsArray()) {
    return Nan::ThrowError("Topic partition must be an array of objects");
  }

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  std::vector<RdKafka::TopicPartition *> toppars =
    Conversion::TopicPartition::FromV8Array(info[0].As<v8::Array>());

  Baton b = consumer->OffsetsStore(toppars);
  RdKafka::TopicPartition::destroy(toppars);

  int error_code = static_cast<int>(b.err());
  info.GetReturnValue().Set(Nan::New<v8::Number>(error_code));
}

NAN_METHOD(KafkaConsumer::NodeOffsetsStoreSingle) {
  Nan::HandleScope scope;

  // If number of parameters is less than 3 (need topic partition, partition,
  // offset, and leader epoch), we can't call this.
  if (info.Length() < 4) {
    return Nan::ThrowError(
        "Must provide topic, partition, offset and leaderEpoch");
  }

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  // Get string pointer for the topic name
  Nan::Utf8String topicUTF8(Nan::To<v8::String>(info[0]).ToLocalChecked());
  const std::string& topic_name(*topicUTF8);

  int64_t partition = Nan::To<int64_t>(info[1]).FromJust();
  int64_t offset = Nan::To<int64_t>(info[2]).FromJust();
  int64_t leader_epoch = Nan::To<int64_t>(info[3]).FromJust();

  RdKafka::TopicPartition* toppar =
      RdKafka::TopicPartition::create(topic_name, partition, offset);
  toppar->set_leader_epoch(leader_epoch);
  std::vector<RdKafka::TopicPartition*> toppars = {toppar};

  Baton b = consumer->OffsetsStore(toppars);

  delete toppar;

  int error_code = static_cast<int>(b.err());
  info.GetReturnValue().Set(Nan::New<v8::Number>(error_code));
}

NAN_METHOD(KafkaConsumer::NodePause) {
  Nan::HandleScope scope;

  // If number of parameters is less than 3 (need topic partition, timeout,
  // and callback), we can't call this thing
  if (info.Length() < 1) {
    return Nan::ThrowError("Must provide a list of topic partitions");
  }

  if (!info[0]->IsArray()) {
    return Nan::ThrowError("Topic partition must be an array of objects");
  }

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  std::vector<RdKafka::TopicPartition *> toppars =
    Conversion::TopicPartition::FromV8Array(info[0].As<v8::Array>());

  Baton b = consumer->Pause(toppars);
  RdKafka::TopicPartition::destroy(toppars);

  #if 0
  // Now iterate through and delete these toppars
  for (std::vector<RdKafka::TopicPartition *>::const_iterator it = toppars.begin();  // NOLINT
       it != toppars.end(); it++) {
    RdKafka::TopicPartition* toppar = *it;
    if (toppar->err() != RdKafka::ERR_NO_ERROR) {
      // Need to somehow transmit this information.
      // @TODO(webmakersteve)
    }
    delete toppar;
  }
  #endif

  int error_code = static_cast<int>(b.err());
  info.GetReturnValue().Set(Nan::New<v8::Number>(error_code));
}

NAN_METHOD(KafkaConsumer::NodeResume) {
  Nan::HandleScope scope;

  // If number of parameters is less than 3 (need topic partition, timeout,
  // and callback), we can't call this thing
  if (info.Length() < 1) {
    return Nan::ThrowError("Must provide a list of topic partitions");  // NOLINT
  }

  if (!info[0]->IsArray()) {
    return Nan::ThrowError("Topic partition must be an array of objects");
  }

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  std::vector<RdKafka::TopicPartition *> toppars =
    Conversion::TopicPartition::FromV8Array(info[0].As<v8::Array>());

  Baton b = consumer->Resume(toppars);

  // Now iterate through and delete these toppars
  for (std::vector<RdKafka::TopicPartition *>::const_iterator it = toppars.begin();  // NOLINT
       it != toppars.end(); it++) {
    RdKafka::TopicPartition* toppar = *it;
    if (toppar->err() != RdKafka::ERR_NO_ERROR) {
      // Need to somehow transmit this information.
      // @TODO(webmakersteve)
    }
    delete toppar;
  }

  int error_code = static_cast<int>(b.err());
  info.GetReturnValue().Set(Nan::New<v8::Number>(error_code));
}

NAN_METHOD(KafkaConsumer::NodeConsumeLoop) {
  Nan::HandleScope scope;

  if (info.Length() < 3) {
    // Just throw an exception
    return Nan::ThrowError("Invalid number of parameters");
  }

  if (!info[0]->IsNumber()) {
    return Nan::ThrowError("Need to specify a timeout");
  }

  if (!info[1]->IsNumber()) {
    return Nan::ThrowError("Need to specify a sleep delay");
  }

  if (!info[2]->IsFunction()) {
    return Nan::ThrowError("Need to specify a callback");
  }

  int timeout_ms;
  Nan::Maybe<uint32_t> maybeTimeout =
    Nan::To<uint32_t>(info[0].As<v8::Number>());

  if (maybeTimeout.IsNothing()) {
    timeout_ms = 1000;
  } else {
    timeout_ms = static_cast<int>(maybeTimeout.FromJust());
  }

  int timeout_sleep_delay_ms;
  Nan::Maybe<uint32_t> maybeSleep =
    Nan::To<uint32_t>(info[1].As<v8::Number>());

  if (maybeSleep.IsNothing()) {
    timeout_sleep_delay_ms = 500;
  } else {
    timeout_sleep_delay_ms = static_cast<int>(maybeSleep.FromJust());
  }

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  if (consumer->m_consume_loop != nullptr) {
    return Nan::ThrowError("Consume was already called");
  }

  if (!consumer->IsConnected()) {
    return Nan::ThrowError("Connect must be called before consume");
  }

  v8::Local<v8::Function> cb = info[2].As<v8::Function>();

  Nan::Callback *callback = new Nan::Callback(cb);

  consumer->m_consume_loop =
    new Workers::KafkaConsumerConsumeLoop(callback, consumer, timeout_ms, timeout_sleep_delay_ms); // NOLINT

  info.GetReturnValue().Set(Nan::Null());
}

NAN_METHOD(KafkaConsumer::NodeConsume) {
  Nan::HandleScope scope;

  if (info.Length() < 2) {
    // Just throw an exception
    return Nan::ThrowError("Invalid number of parameters");
  }

  int timeout_ms;
  Nan::Maybe<uint32_t> maybeTimeout =
    Nan::To<uint32_t>(info[0].As<v8::Number>());

  if (maybeTimeout.IsNothing()) {
    timeout_ms = 1000;
  } else {
    timeout_ms = static_cast<int>(maybeTimeout.FromJust());
  }

  if (info[1]->IsNumber()) {
    if (!info[2]->IsBoolean()) {
      return Nan::ThrowError("Need to specify a boolean");
    }

    if (!info[3]->IsFunction()) {
      return Nan::ThrowError("Need to specify a callback");
    }

    v8::Local<v8::Number> numMessagesNumber = info[1].As<v8::Number>();
    Nan::Maybe<uint32_t> numMessagesMaybe = Nan::To<uint32_t>(numMessagesNumber);  // NOLINT

    uint32_t numMessages;
    if (numMessagesMaybe.IsNothing()) {
      return Nan::ThrowError("Parameter must be a number over 0");
    } else {
      numMessages = numMessagesMaybe.FromJust();
    }

    v8::Local<v8::Boolean> isTimeoutOnlyForFirstMessageBoolean = info[2].As<v8::Boolean>(); // NOLINT
    Nan::Maybe<bool> isTimeoutOnlyForFirstMessageMaybe =
      Nan::To<bool>(isTimeoutOnlyForFirstMessageBoolean);

    bool isTimeoutOnlyForFirstMessage;
    if (isTimeoutOnlyForFirstMessageMaybe.IsNothing()) {
      return Nan::ThrowError("Parameter must be a boolean");
    } else {
      isTimeoutOnlyForFirstMessage = isTimeoutOnlyForFirstMessageMaybe.FromJust(); // NOLINT
    }

    KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

    v8::Local<v8::Function> cb = info[3].As<v8::Function>();
    Nan::Callback *callback = new Nan::Callback(cb);
    Nan::AsyncQueueWorker(
      new Workers::KafkaConsumerConsumeNum(callback, consumer, numMessages, timeout_ms, isTimeoutOnlyForFirstMessage));  // NOLINT

  } else {
    if (!info[1]->IsFunction()) {
      return Nan::ThrowError("Need to specify a callback");
    }

    KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

    v8::Local<v8::Function> cb = info[1].As<v8::Function>();
    Nan::Callback *callback = new Nan::Callback(cb);
    Nan::AsyncQueueWorker(
      new Workers::KafkaConsumerConsume(callback, consumer, timeout_ms));
  }

  info.GetReturnValue().Set(Nan::Null());
}

NAN_METHOD(KafkaConsumer::NodeConnect) {
  Nan::HandleScope scope;

  if (info.Length() < 1 || !info[0]->IsFunction()) {
    // Just throw an exception
    return Nan::ThrowError("Need to specify a callback");
  }

  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  Nan::Callback *callback = new Nan::Callback(info[0].As<v8::Function>());
  Nan::AsyncQueueWorker(new Workers::KafkaConsumerConnect(callback, consumer));

  info.GetReturnValue().Set(Nan::Null());
}

NAN_METHOD(KafkaConsumer::NodeDisconnect) {
  Nan::HandleScope scope;

  if (info.Length() < 1 || !info[0]->IsFunction()) {
    // Just throw an exception
    return Nan::ThrowError("Need to specify a callback");
  }

  v8::Local<v8::Function> cb = info[0].As<v8::Function>();
  Nan::Callback *callback = new Nan::Callback(cb);
  KafkaConsumer* consumer = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  Workers::KafkaConsumerConsumeLoop* consumeLoop =
    (Workers::KafkaConsumerConsumeLoop*)consumer->m_consume_loop;
  if (consumeLoop != nullptr) {
    // stop the consume loop
    consumeLoop->Close();

    // cleanup the async worker
    consumeLoop->WorkComplete();
    consumeLoop->Destroy();

    consumer->m_consume_loop = nullptr;
  }

  Nan::AsyncQueueWorker(
    new Workers::KafkaConsumerDisconnect(callback, consumer));
  info.GetReturnValue().Set(Nan::Null());
}

NAN_METHOD(KafkaConsumer::NodeGetWatermarkOffsets) {
  Nan::HandleScope scope;

  KafkaConsumer* obj = ObjectWrap::Unwrap<KafkaConsumer>(info.This());

  if (!info[0]->IsString()) {
    Nan::ThrowError("1st parameter must be a topic string");;
    return;
  }

  if (!info[1]->IsNumber()) {
    Nan::ThrowError("2nd parameter must be a partition number");
    return;
  }

  // Get string pointer for the topic name
  Nan::Utf8String topicUTF8(Nan::To<v8::String>(info[0]).ToLocalChecked());
  // The first parameter is the topic
  std::string topic_name(*topicUTF8);

  // Second parameter is the partition
  int32_t partition = Nan::To<int32_t>(info[1]).FromJust();

  // Set these ints which will store the return data
  int64_t low_offset;
  int64_t high_offset;

  Baton b = obj->GetWatermarkOffsets(
    topic_name, partition, &low_offset, &high_offset);

  if (b.err() != RdKafka::ERR_NO_ERROR) {
    // Let the JS library throw if we need to so the error can be more rich
    int error_code = static_cast<int>(b.err());
    return info.GetReturnValue().Set(Nan::New<v8::Number>(error_code));
  } else {
    v8::Local<v8::Object> offsetsObj = Nan::New<v8::Object>();
    Nan::Set(offsetsObj, Nan::New<v8::String>("lowOffset").ToLocalChecked(),
      Nan::New<v8::Number>(low_offset));
    Nan::Set(offsetsObj, Nan::New<v8::String>("highOffset").ToLocalChecked(),
      Nan::New<v8::Number>(high_offset));

    return info.GetReturnValue().Set(offsetsObj);
  }
}

}  // namespace NodeKafka

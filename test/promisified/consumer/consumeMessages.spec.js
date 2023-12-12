jest.setTimeout(30000)

const { ErrorCodes } = require('../../../lib').KafkaJS;

const {
    secureRandom,
    createTopic,
    waitFor,
    createProducer,
    createConsumer,
    waitForMessages,
    waitForConsumerToJoinGroup,
    sleep,
    generateMessages,
} = require('../testhelpers')

describe('Consumer', () => {
    let topicName, groupId, producer, consumer;

    beforeEach(async () => {
        topicName = `test-topic-${secureRandom()}`
        groupId = `consumer-group-id-${secureRandom()}`

        await createTopic({ topic: topicName })

        producer = createProducer({});

        consumer = createConsumer({
            groupId,
            maxWaitTimeInMs: 100,
            rdKafka: {
                topicConfig: {
                    'auto.offset.reset': 'earliest',
                }
            }
        });
    });

    afterEach(async () => {
        consumer && (await consumer.disconnect())
        producer && (await producer.disconnect())
    });

    it('consume messages', async () => {
        await consumer.connect();
        await producer.connect();
        await consumer.subscribe({ topic: topicName })

        const messagesConsumed = [];
        consumer.run({ eachMessage: async event => messagesConsumed.push(event) });

        const messages = Array(100)
            .fill()
            .map(() => {
                const value = secureRandom()
                return { key: `key-${value}`, value: `value-${value}` }
            })

        await producer.send({ topic: topicName, messages })
        await waitForMessages(messagesConsumed, { number: messages.length })

        expect(messagesConsumed[0]).toEqual(
            expect.objectContaining({
                topic: topicName,
                partition: 0,
                message: expect.objectContaining({
                    key: Buffer.from(messages[0].key),
                    value: Buffer.from(messages[0].value),
                    offset: '0',
                }),
            })
        )

        expect(messagesConsumed[messagesConsumed.length - 1]).toEqual(
            expect.objectContaining({
                topic: topicName,
                partition: 0,
                message: expect.objectContaining({
                    key: Buffer.from(messages[messages.length - 1].key),
                    value: Buffer.from(messages[messages.length - 1].value),
                    offset: '99',
                }),
            })
        )

        // check if all offsets are present
        expect(messagesConsumed.map(m => m.message.offset)).toEqual(messages.map((_, i) => `${i}`))
    });

    /* Skip until concurrency support for eachMessage is added. */
    it.skip('consumes messages concurrently', async () => {
        const partitionsConsumedConcurrently = 2
        topicName = `test-topic-${secureRandom()}`
        await createTopic({
            topic: topicName,
            partitions: partitionsConsumedConcurrently + 1,
        })
        await consumer.connect()
        await producer.connect()
        await consumer.subscribe({ topic: topicName })

        let inProgress = 0
        let hitConcurrencyLimit = false
        consumer.on(consumer.events.START_BATCH_PROCESS, () => {
            inProgress++
            expect(inProgress).toBeLessThanOrEqual(partitionsConsumedConcurrently)
            hitConcurrencyLimit = hitConcurrencyLimit || inProgress === partitionsConsumedConcurrently
        })
        consumer.on(consumer.events.END_BATCH_PROCESS, () => inProgress--)

        const messagesConsumed = []
        consumer.run({
            partitionsConsumedConcurrently,
            eachMessage: async event => {
                await sleep(1)
                messagesConsumed.push(event)
            },
        })

        await waitForConsumerToJoinGroup(consumer)

        const messages = Array(100)
            .fill()
            .map(() => {
                const value = secureRandom()
                return { key: `key-${value}`, value: `value-${value}` }
            })

        await producer.send({ topic: topicName, messages })
        await waitForMessages(messagesConsumed, { number: messages.length })

        expect(hitConcurrencyLimit).toBeTrue()
    });

    it('consume GZIP messages', async () => {
        /* Discard and recreate producer with the compression set */
        producer = createProducer({
            rdKafka: {
                globalConfig: {
                    'compression.codec': 'gzip',
                }
            }
        });

        await consumer.connect();
        await producer.connect();
        await consumer.subscribe({ topic: topicName });

        const messagesConsumed = [];
        consumer.run({ eachMessage: async event => messagesConsumed.push(event) });

        const key1 = secureRandom();
        const message1 = { key: `key-${key1}`, value: `value-${key1}` };
        const key2 = secureRandom();
        const message2 = { key: `key-${key2}`, value: `value-${key2}` };

        await producer.send({
            topic: topicName,
            messages: [message1, message2],
        });

        await expect(waitForMessages(messagesConsumed, { number: 2 })).resolves.toEqual([
            expect.objectContaining({
                topic: topicName,
                partition: 0,
                message: expect.objectContaining({
                    key: Buffer.from(message1.key),
                    value: Buffer.from(message1.value),
                    offset: '0',
                }),
            }),
            expect.objectContaining({
                topic: topicName,
                partition: 0,
                message: expect.objectContaining({
                    key: Buffer.from(message2.key),
                    value: Buffer.from(message2.value),
                    offset: '1',
                }),
            }),
        ])
    });

    /* Skip as it uses eachBatch */
    it.skip('commits the last offsets processed before stopping', async () => {
        jest.spyOn(cluster, 'refreshMetadataIfNecessary')

        await Promise.all([admin.connect(), consumer.connect(), producer.connect()])
        await consumer.subscribe({ topic: topicName })

        const messagesConsumed = []
        consumer.run({ eachMessage: async event => messagesConsumed.push(event) })
        await waitForConsumerToJoinGroup(consumer)

        // stop the consumer right after processing the batch, the offsets should be
        // committed in the end
        consumer.on(consumer.events.END_BATCH_PROCESS, async () => {
            await consumer.stop()
        })

        const messages = Array(100)
            .fill()
            .map(() => {
                const value = secureRandom()
                return { key: `key-${value}`, value: `value-${value}` }
            })

        await producer.send({ topic: topicName, messages })
        await waitForMessages(messagesConsumed, { number: messages.length })

        expect(cluster.refreshMetadataIfNecessary).toHaveBeenCalled()

        expect(messagesConsumed[0]).toEqual(
            expect.objectContaining({
                topic: topicName,
                partition: 0,
                message: expect.objectContaining({
                    key: Buffer.from(messages[0].key),
                    value: Buffer.from(messages[0].value),
                    offset: '0',
                }),
            })
        )

        expect(messagesConsumed[messagesConsumed.length - 1]).toEqual(
            expect.objectContaining({
                topic: topicName,
                partition: 0,
                message: expect.objectContaining({
                    key: Buffer.from(messages[messages.length - 1].key),
                    value: Buffer.from(messages[messages.length - 1].value),
                    offset: '99',
                }),
            })
        )

        // check if all offsets are present
        expect(messagesConsumed.map(m => m.message.offset)).toEqual(messages.map((_, i) => `${i}`))
        const response = await admin.fetchOffsets({ groupId, topics: [topicName] })
        const { partitions } = response.find(({ topic }) => topic === topicName)
        const partition = partitions.find(({ partition }) => partition === 0)
        expect(partition.offset).toEqual('100') // check if offsets were committed
    });

    it('stops consuming messages when running = false', async () => {
        await consumer.connect();
        await producer.connect();
        await consumer.subscribe({ topic: topicName });

        let calls = 0;

        consumer.run({
            eachMessage: async event => {
                calls++;
                await sleep(100);
            },
        });

        const key1 = secureRandom();
        const message1 = { key: `key-${key1}`, value: `value-${key1}` };
        const key2 = secureRandom();
        const message2 = { key: `key-${key2}`, value: `value-${key2}` };

        await producer.send({ topic: topicName, messages: [message1, message2] });
        await waitFor(() => calls > 0, () => { }, 10);
        await consumer.disconnect(); // don't give the consumer the chance to consume the 2nd message

        expect(calls).toEqual(1);
    });

    describe('discarding messages after seeking', () => {
        it('stops consuming messages when fetched batch has gone stale', async () => {
            consumer = createConsumer({
                groupId,
                minBytes: 1024,
                maxWaitTimeInMs: 500,
                rdKafka: {
                    topicConfig: {
                        'auto.offset.reset': 'earliest',
                    }
                }
            });

            const messages = Array(10)
                .fill()
                .map(() => {
                    const value = secureRandom()
                    return { key: `key-${value}`, value: `value-${value}` }
                });

            await consumer.connect();
            await producer.connect();
            await producer.send({ topic: topicName, messages });
            await consumer.subscribe({ topic: topicName });

            const offsetsConsumed = [];

            consumer.run({
                eachMessage: async ({ message }) => {
                    offsetsConsumed.push(message.offset)

                    if (offsetsConsumed.length === 1) {
                        consumer.seek({ topic: topicName, partition: 0, offset: message.offset });
                    }
                },
            })

            await waitFor(() => offsetsConsumed.length >= 2, () => { }, { delay: 50 })

            expect(offsetsConsumed[0]).toEqual(offsetsConsumed[1])
        });

        /* Skip as it uses eachBatch */
        it.skip('resolves a batch as stale when seek was called while processing it', async () => {
            consumer = createConsumer({
                groupId,
                // make sure we fetch a batch of messages
                minBytes: 1024,
                maxWaitTimeInMs: 500,
                rdKafka: {
                    topicConfig: {
                        'auto.offset.reset': 'earliest',
                    }
                }
            })

            const messages = Array(10)
                .fill()
                .map(() => {
                    const value = secureRandom()
                    return { key: `key-${value}`, value: `value-${value}` }
                })

            await consumer.connect()
            await producer.connect()
            await producer.send({ topic: topicName, messages })
            await consumer.subscribe({ topic: topicName })

            const offsetsConsumed = []

            consumer.run({
                eachBatch: async ({ batch, isStale, heartbeat, resolveOffset }) => {
                    for (const message of batch.messages) {
                        if (isStale()) break

                        offsetsConsumed.push(message.offset)

                        if (offsetsConsumed.length === 1) {
                            consumer.seek({ topic: topicName, partition: 0, offset: message.offset })
                        }

                        resolveOffset(message.offset)
                        await heartbeat()
                    }
                },
            })

            await waitFor(() => offsetsConsumed.length >= 2, { delay: 50 })

            expect(offsetsConsumed[0]).toEqual(offsetsConsumed[1])
        });

        /* Skip as it uses eachBatch */
        it.skip('skips messages fetched while seek was called', async () => {
            consumer = createConsumer({
                cluster: createCluster(),
                groupId,
                maxWaitTimeInMs: 1000,
                logger: newLogger(),
            })

            const messages = Array(10)
                .fill()
                .map(() => {
                    const value = secureRandom()
                    return { key: `key-${value}`, value: `value-${value}` }
                })
            await producer.connect()
            await producer.send({ topic: topicName, messages })

            await consumer.connect()

            await consumer.subscribe({ topic: topicName })

            const offsetsConsumed = []

            const eachBatch = async ({ batch, heartbeat }) => {
                for (const message of batch.messages) {
                    offsetsConsumed.push(message.offset)
                }

                await heartbeat()
            }

            consumer.run({
                eachBatch,
            })

            await waitForConsumerToJoinGroup(consumer)

            await waitFor(() => offsetsConsumed.length === messages.length, { delay: 50 })
            await waitForNextEvent(consumer, consumer.events.FETCH_START)

            const seekedOffset = offsetsConsumed[Math.floor(messages.length / 2)]
            consumer.seek({ topic: topicName, partition: 0, offset: seekedOffset })
            await producer.send({ topic: topicName, messages }) // trigger completion of fetch

            await waitFor(() => offsetsConsumed.length > messages.length, { delay: 50 })

            expect(offsetsConsumed[messages.length]).toEqual(seekedOffset)
        });
    });

    /* Skip as it uses eachBatch */
    it.skip('discards messages received when pausing while fetch is in-flight', async () => {
        consumer = createConsumer({
            cluster: createCluster(),
            groupId,
            maxWaitTimeInMs: 200,
            logger: newLogger(),
        })

        const messages = Array(10)
            .fill()
            .map(() => {
                const value = secureRandom()
                return { key: `key-${value}`, value: `value-${value}` }
            })
        await producer.connect()
        await producer.send({ topic: topicName, messages })

        await consumer.connect()

        await consumer.subscribe({ topic: topicName })

        const offsetsConsumed = []

        const eachBatch = async ({ batch, heartbeat }) => {
            for (const message of batch.messages) {
                offsetsConsumed.push(message.offset)
            }

            await heartbeat()
        }

        consumer.run({
            eachBatch,
        })

        await waitForConsumerToJoinGroup(consumer)
        await waitFor(() => offsetsConsumed.length === messages.length, { delay: 50 })
        await waitForNextEvent(consumer, consumer.events.FETCH_START)

        consumer.pause([{ topic: topicName }])
        await producer.send({ topic: topicName, messages }) // trigger completion of fetch

        await waitForNextEvent(consumer, consumer.events.FETCH)

        expect(offsetsConsumed.length).toEqual(messages.length)
    });

    describe('transactions', () => {
        it('accepts messages from an idempotent producer', async () => {
            producer = createProducer({
                idempotent: true,
                maxInFlightRequests: 1,
            })

            consumer = createConsumer({
                groupId,
                maxWaitTimeInMs: 100,
                rdKafka: {
                    topicConfig: {
                        'auto.offset.reset': 'earliest',
                    }
                }
            });

            await consumer.connect();
            await producer.connect();
            await consumer.subscribe({ topic: topicName });

            const messagesConsumed = []
            const idempotentMessages = generateMessages({ prefix: 'idempotent' })

            consumer.run({
                eachMessage: async event => messagesConsumed.push(event),
            })

            await producer.sendBatch({
                topicMessages: [{ topic: topicName, messages: idempotentMessages }],
            })

            const number = idempotentMessages.length;
            await waitForMessages(messagesConsumed, {
                number,
            });

            expect(messagesConsumed).toHaveLength(idempotentMessages.length)
            expect(messagesConsumed[0].message.value.toString()).toMatch(/value-idempotent-0/)
            expect(messagesConsumed[99].message.value.toString()).toMatch(/value-idempotent-99/)
        });

        it('accepts messages from committed transactions', async () => {
            producer = createProducer({
                transactionalId: `transactional-id-${secureRandom()}`,
                maxInFlightRequests: 1,
            });

            consumer = createConsumer({
                groupId,
                maxWaitTimeInMs: 100,
                rdKafka: {
                    globalConfig: {
                        // debug: 'cgrp,topic',
                    },
                    topicConfig: {
                        'auto.offset.reset': 'earliest',
                    }
                }
            });

            await consumer.connect();
            await producer.connect();
            await consumer.subscribe({ topic: topicName });

            const messagesConsumed = [];

            const messages1 = generateMessages({ prefix: 'txn1' });
            const messages2 = generateMessages({ prefix: 'txn2' });
            const nontransactionalMessages1 = generateMessages({ prefix: 'nontransactional1', number: 1 });

            consumer.run({
                eachMessage: async event => messagesConsumed.push(event),
            });

            // We cannot send non-transaction messages.
            await expect(producer.sendBatch({
                topicMessages: [{ topic: topicName, messages: nontransactionalMessages1 }],
            })).rejects.toHaveProperty('code', ErrorCodes.ERR__STATE);

            // We can run a transaction
            const txn1 = await producer.transaction();
            await txn1.sendBatch({
                topicMessages: [{ topic: topicName, messages: messages1 }],
            });
            await txn1.commit();

            // We can immediately run another transaction
            const txn2 = await producer.transaction();
            await txn2.sendBatch({
                topicMessages: [{ topic: topicName, messages: messages2 }],
            });
            await txn2.commit();

            const numMessages =
                messages1.length + messages2.length;

            await waitForMessages(messagesConsumed, {
                number: numMessages,
            })

            expect(messagesConsumed[0].message.value.toString()).toMatch(/value-txn1-0/)
            expect(messagesConsumed[numMessages - 1].message.value.toString()).toMatch(/value-txn2-99/)
        });

        it('does not receive aborted messages', async () => {
            producer = createProducer({
                transactionalId: `transactional-id-${secureRandom()}`,
                maxInFlightRequests: 1,
            });

            consumer = createConsumer({
                groupId,
                maxWaitTimeInMs: 100,
                rdKafka: {
                    topicConfig: {
                        'auto.offset.reset': 'earliest',
                    }
                }
            });

            await consumer.connect();
            await producer.connect();
            await consumer.subscribe({ topic: topicName });

            const messagesConsumed = []

            const abortedMessages1 = generateMessages({ prefix: 'aborted-txn-1' });
            const abortedMessages2 = generateMessages({ prefix: 'aborted-txn-2' });
            const committedMessages = generateMessages({ prefix: 'committed-txn', number: 10 });

            consumer.run({
                eachMessage: async event => messagesConsumed.push(event),
            });

            const abortedTxn1 = await producer.transaction();
            await abortedTxn1.sendBatch({
                topicMessages: [{ topic: topicName, messages: abortedMessages1 }],
            });
            await abortedTxn1.abort();

            const abortedTxn2 = await producer.transaction();
            await abortedTxn2.sendBatch({
                topicMessages: [{ topic: topicName, messages: abortedMessages2 }],
            });
            await abortedTxn2.abort();

            const committedTxn = await producer.transaction();
            await committedTxn.sendBatch({
                topicMessages: [{ topic: topicName, messages: committedMessages }],
            });
            await committedTxn.commit();

            const number = committedMessages.length
            await waitForMessages(messagesConsumed, {
                number,
            });

            expect(messagesConsumed).toHaveLength(number);
            expect(messagesConsumed[0].message.value.toString()).toMatch(/value-committed-txn-0/);
            expect(messagesConsumed[number - 1].message.value.toString()).toMatch(/value-committed-txn-9/);
        });

        it(
            'receives aborted messages for an isolation level of READ_UNCOMMITTED',
            async () => {
                producer = createProducer({
                    transactionalId: `transactional-id-${secureRandom()}`,
                    maxInFlightRequests: 1,
                })

                consumer = createConsumer({
                    groupId,
                    maxWaitTimeInMs: 100,
                    readUncommitted: true,
                    rdKafka: {
                        topicConfig: {
                            'auto.offset.reset': 'earliest',
                        }
                    }
                })

                await consumer.connect();
                await producer.connect();
                await consumer.subscribe({ topic: topicName });

                const messagesConsumed = [];

                const abortedMessages = generateMessages({ prefix: 'aborted-txn1' });

                consumer.run({
                    eachMessage: async event => messagesConsumed.push(event),
                });

                const abortedTxn1 = await producer.transaction();
                await abortedTxn1.sendBatch({
                    topicMessages: [{ topic: topicName, messages: abortedMessages }],
                });
                await abortedTxn1.abort();

                const number = abortedMessages.length;
                await waitForMessages(messagesConsumed, {
                    number,
                });

                expect(messagesConsumed).toHaveLength(abortedMessages.length);
                expect(messagesConsumed[0].message.value.toString()).toMatch(/value-aborted-txn1-0/);
                expect(messagesConsumed[messagesConsumed.length - 1].message.value.toString()).toMatch(
                    /value-aborted-txn1-99/
                );
            }
        );

        it(
            'respects offsets sent by a committed transaction ("consume-transform-produce" flow)',
            async () => {
                // Seed the topic with some messages. We don't need a tx producer for this.
                await producer.connect();

                const partition = 0;
                const messages = generateMessages().map(message => ({
                    ...message,
                    partition,
                }));

                await producer.send({
                    topic: topicName,
                    messages,
                })

                await producer.disconnect();

                producer = createProducer({
                    transactionalId: `transactional-id-${secureRandom()}`,
                    maxInFlightRequests: 1,
                })

                consumer = createConsumer({
                    groupId,
                    maxWaitTimeInMs: 100,
                    rdKafka: {
                        globalConfig: {
                            'enable.auto.commit': false,
                        },
                        topicConfig: {
                            'auto.offset.reset': 'earliest',
                        }
                    }
                });

                await consumer.connect();
                await producer.connect();
                await consumer.subscribe({ topic: topicName });

                // 1. Run consumer with "autoCommit=false"

                let messagesConsumed = [];
                // This stores the latest offsets consumed for each partition, when we received the ith message.
                let uncommittedOffsetsPerMessage = [];
                let latestOffsetsPerPartition = {};

                const eachMessage = async ({ topic, partition, message }) => {
                    messagesConsumed.push(message)
                    /* The message.offset indicates current offset, so we need to add 1 to it, since committed offset denotes
                     * the next offset to consume. */
                    latestOffsetsPerPartition[partition] = Number(message.offset) + 1;
                    uncommittedOffsetsPerMessage.push(Object.assign({}, latestOffsetsPerPartition));
                };

                consumer.run({
                    eachMessage,
                })

                // Consume pre-produced messages.

                const number = messages.length;
                await waitForMessages(messagesConsumed, {
                    number,
                })

                expect(messagesConsumed[0].value.toString()).toMatch(/value-0/)
                expect(messagesConsumed[99].value.toString()).toMatch(/value-99/)
                expect(uncommittedOffsetsPerMessage).toHaveLength(messagesConsumed.length)

                // 3. Send offsets in a transaction and commit
                const txnToCommit = await producer.transaction();
                let offsetsToCommit = uncommittedOffsetsPerMessage[97];
                let topicPartitionOffsets = { topic: topicName, partitions: [] };
                for (const partition in offsetsToCommit) {
                    topicPartitionOffsets.partitions.push({ partition, offset: offsetsToCommit[partition] });
                }

                await txnToCommit.sendOffsets({
                    consumer,
                    topics: [topicPartitionOffsets],
                });
                await txnToCommit.commit();

                // Restart consumer - we cannot stop it, so we recreate it.
                await consumer.disconnect();

                consumer = createConsumer({
                    groupId,
                    maxWaitTimeInMs: 100,
                    rdKafka: {
                        globalConfig: {
                            'enable.auto.commit': false,
                        },
                        topicConfig: {
                            'auto.offset.reset': 'earliest',
                        }
                    }
                });

                await consumer.connect();
                await consumer.subscribe({ topic: topicName });

                messagesConsumed = []
                uncommittedOffsetsPerMessage = []

                consumer.run({ eachMessage })

                // Assert we only consume the messages that were after the sent offset
                await waitForMessages(messagesConsumed, {
                    number: 2,
                })

                expect(messagesConsumed).toHaveLength(2);
                expect(messagesConsumed[0].value.toString()).toMatch(/value-98/);
                expect(messagesConsumed[1].value.toString()).toMatch(/value-99/);
            }
        );

        it(
            'does not respect offsets sent by an aborted transaction ("consume-transform-produce" flow)',
            async () => {
                // Seed the topic with some messages. We don't need a tx producer for this.
                await producer.connect();

                const partition = 0;
                const messages = generateMessages().map(message => ({
                    ...message,
                    partition,
                }));

                await producer.send({
                    topic: topicName,
                    messages,
                })

                await producer.disconnect();

                producer = createProducer({
                    transactionalId: `transactional-id-${secureRandom()}`,
                    maxInFlightRequests: 1,
                })

                consumer = createConsumer({
                    groupId,
                    maxWaitTimeInMs: 100,
                    rdKafka: {
                        topicConfig: {
                            'auto.offset.reset': 'earliest',
                        },
                        globalConfig: {
                            'enable.auto.commit': false,
                        },
                    }
                });

                await consumer.connect();
                await producer.connect();
                await consumer.subscribe({ topic: topicName });

                // 1. Run consumer with "autoCommit=false"

                let messagesConsumed = [];
                // This stores the latest offsets consumed for each partition, when we received the ith message.
                let uncommittedOffsetsPerMessage = [];
                let latestOffsetsPerPartition = {};

                const eachMessage = async ({ topic, partition, message }) => {
                    messagesConsumed.push(message)
                    /* The message.offset indicates current offset, so we need to add 1 to it, since committed offset denotes
                     * the next offset to consume. */
                    latestOffsetsPerPartition[partition] = Number(message.offset) + 1;
                    uncommittedOffsetsPerMessage.push(Object.assign({}, latestOffsetsPerPartition));
                };

                consumer.run({
                    eachMessage,
                })

                // Consume produced messages.
                await waitForMessages(messagesConsumed, { number: messages.length });

                // Restart consumer - we cannot stop it, so we recreate it.
                await consumer.disconnect();

                consumer = createConsumer({
                    groupId,
                    maxWaitTimeInMs: 100,
                    rdKafka: {
                        globalConfig: {
                            'enable.auto.commit': false,
                        },
                        topicConfig: {
                            'auto.offset.reset': 'earliest',
                        }
                    }
                });

                await consumer.connect();
                await consumer.subscribe({ topic: topicName });

                expect(messagesConsumed[0].value.toString()).toMatch(/value-0/);
                expect(messagesConsumed[99].value.toString()).toMatch(/value-99/);
                expect(uncommittedOffsetsPerMessage).toHaveLength(messagesConsumed.length);

                // 3. Send offsets in a transaction and commit
                const txnToAbort = await producer.transaction();
                let offsetsToCommit = uncommittedOffsetsPerMessage[97];
                let topicPartitionOffsets = { topic: topicName, partitions: [] };
                for (const partition in offsetsToCommit) {
                    topicPartitionOffsets.partitions.push({ partition, offset: offsetsToCommit[partition] });
                }

                await txnToAbort.sendOffsets({
                    consumer,
                    topics: [topicPartitionOffsets],
                });
                await txnToAbort.abort()

                // Restart consumer
                messagesConsumed = []
                uncommittedOffsetsPerMessage = []

                consumer.run({
                  eachMessage
                })

                await waitForMessages(messagesConsumed, { number: 1 });
                expect(messagesConsumed[0].value.toString()).toMatch(/value-0/)
                await waitForMessages(messagesConsumed, { number: messages.length });
                expect(messagesConsumed[messagesConsumed.length - 1].value.toString()).toMatch(/value-99/)
            }
        );
    });
});

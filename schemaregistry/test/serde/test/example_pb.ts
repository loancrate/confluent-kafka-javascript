// @generated by protoc-gen-es v2.0.0 with parameter "target=ts"
// @generated from file test/schemaregistry/serde/example.proto (package test, syntax proto3)
/* eslint-disable */

import type { GenFile, GenMessage } from "@bufbuild/protobuf/codegenv1";
import { fileDesc, messageDesc } from "@bufbuild/protobuf/codegenv1";
import { file_confluent_meta } from "../../../confluent/meta_pb";
import type { Message } from "@bufbuild/protobuf";

/**
 * Describes the file test/schemaregistry/serde/example.proto.
 */
export const file_test_schemaregistry_serde_example: GenFile = /*@__PURE__*/
  fileDesc("Cid0ZXN0L3NjaGVtYXJlZ2lzdHJ5L3NlcmRlL2V4YW1wbGUucHJvdG8SBHRlc3QiVgoGQXV0aG9yEhYKBG5hbWUYASABKAlCCIJEBRoDUElJEgoKAmlkGAIgASgFEhkKB3BpY3R1cmUYAyABKAxCCIJEBRoDUElJEg0KBXdvcmtzGAQgAygJIicKBVBpenphEgwKBHNpemUYASABKAkSEAoIdG9wcGluZ3MYAiADKAlCCVoHLi4vdGVzdGIGcHJvdG8z", [file_confluent_meta]);

/**
 * @generated from message test.Author
 */
export type Author = Message<"test.Author"> & {
  /**
   * @generated from field: string name = 1;
   */
  name: string;

  /**
   * @generated from field: int32 id = 2;
   */
  id: number;

  /**
   * @generated from field: bytes picture = 3;
   */
  picture: Uint8Array;

  /**
   * @generated from field: repeated string works = 4;
   */
  works: string[];
};

/**
 * Describes the message test.Author.
 * Use `create(AuthorSchema)` to create a new message.
 */
export const AuthorSchema: GenMessage<Author> = /*@__PURE__*/
  messageDesc(file_test_schemaregistry_serde_example, 0);

/**
 * @generated from message test.Pizza
 */
export type Pizza = Message<"test.Pizza"> & {
  /**
   * @generated from field: string size = 1;
   */
  size: string;

  /**
   * @generated from field: repeated string toppings = 2;
   */
  toppings: string[];
};

/**
 * Describes the message test.Pizza.
 * Use `create(PizzaSchema)` to create a new message.
 */
export const PizzaSchema: GenMessage<Pizza> = /*@__PURE__*/
  messageDesc(file_test_schemaregistry_serde_example, 1);

import assert from "node:assert/strict";
import test from "node:test";
import { rabiLinkRelayTaskDisposition } from "./rabilinkRelayWorker.js";

test("RabiLink observations are record-only while explicit messages remain direct", () => {
  assert.equal(rabiLinkRelayTaskDisposition({
    type: "rabilink.observation",
    deliveryMode: "observe",
    text: "ambient transcript"
  }), "record_only");
  assert.equal(rabiLinkRelayTaskDisposition({
    type: "rabilink",
    deliveryMode: "observe",
    text: "record this without delivering it"
  }), "record_only");
  assert.equal(rabiLinkRelayTaskDisposition({
    type: "rabilink",
    text: "explicit direct input"
  }), "direct");
});

test("RabiLink touchpad review requests wake the reviewer without becoming direct input", () => {
  assert.equal(rabiLinkRelayTaskDisposition({
    type: "rabilink.review_request",
    deliveryMode: "observe",
    reviewRequested: true
  }), "review_request");
  assert.equal(rabiLinkRelayTaskDisposition({
    type: "rabilink.observation",
    deliveryMode: "observe",
    reviewRequested: true
  }), "review_request");
});

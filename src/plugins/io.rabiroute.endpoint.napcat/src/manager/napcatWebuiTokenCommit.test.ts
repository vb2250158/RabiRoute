import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayDefinition } from "@rabiroute/host-api/shared/gatewayConfigModel";
import { prepareNapcatWebuiTokenCommit, type NapcatWebuiTokenCommitPorts } from "./napcatWebuiTokenCommit.js";
test("token commit changes only its captured original source via single-Route CAS and retains original operation recovery", async () => {
    let route = {
        id: "route", enabled: true, rolesDir: "keep", messageAdapters: ["napcat"], napcatInstances: [{
                id: "instance", enabled: true, botUserId: "12345", webuiToken: "ORIGINAL", workingDir: "keep"
            }]
    } as GatewayDefinition;
    let revision = "before", writes = 0, resolves = 0, failAfterWrite = true;
    const captured = route, binding = {
        routeId: "route", instanceId: "instance", expectedUserId: "12345", assertCurrent: () => {
            if (route !== captured)
                throw new Error("Old binding obsolete");
        }
    };
    const ports: NapcatWebuiTokenCommitPorts = {
        assertCurrent: () => {
        }, readRoutes: () => [structuredClone(route)], routeVersion: () => revision, syncRoutes: () => {
        }, inspectSource: async (_binding, token) => ({
            credentialSource: "provided", explicitTokenSource: "instance", nativeConfigMatches: false, configuredValueMatches: token === route.napcatInstances![0]!.webuiToken
        }), writeRoute: async (id, definition, hash, operationId) => {
            assert.equal(id, "route");
            assert.equal(hash, "before");
            assert.equal(operationId, "original-intent");
            route = structuredClone(definition);
            revision = "after";
            writes++;
            if (failAfterWrite)
                throw new Error("Connection closed after commit");
        }, resolveRouteMutation: async (operationId) => {
            assert.equal(operationId, "original-intent");
            resolves++;
            return { state: "committed" };
        }
    };
    const prepared = await prepareNapcatWebuiTokenCommit(ports, binding, "original-intent"), committed = await prepared.commit("NEW_VALUE");
    assert.equal(committed.state, "committed");
    committed.assertCurrent();
    assert.equal(writes, 1);
    assert.equal(resolves, 1);
    assert.throws(binding.assertCurrent);
    assert.equal(route.rolesDir, "keep");
    assert.equal(route.napcatInstances![0]!.workingDir, "keep");
    assert.equal(route.napcatInstances![0]!.webuiToken, "NEW_VALUE");
    route.napcatInstances![0]!.webuiUrl = "http://different-native.example";
    assert.throws(committed.assertCurrent);
    delete route.napcatInstances![0]!.webuiUrl;
    route.napcatInstances![0]!.workingDir = "different-source";
    assert.throws(committed.assertCurrent);
    route.napcatInstances![0]!.workingDir = "keep";
    route.napcatInstances![0]!.id = "different-instance";
    assert.throws(committed.assertCurrent);
    route.napcatInstances![0]!.id = "instance";
    committed.assertCurrent();
    route.napcatInstances![0]!.webuiToken = "OTHER_OWNER";
    assert.throws(committed.assertCurrent);
});
test("unresolved native-success/config-CAS keeps an admissible uncertain receipt fence without a second write", async () => {
    const route = {
        id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [{
                id: "instance", enabled: true, botUserId: "12345", webuiToken: "ORIGINAL"
            }]
    } as GatewayDefinition;
    let writes = 0;
    const binding = {
        routeId: "route", instanceId: "instance", expectedUserId: "12345", assertCurrent: () => {
        }
    };
    const ports: NapcatWebuiTokenCommitPorts = {
        assertCurrent: () => {
        }, readRoutes: () => [structuredClone(route)], routeVersion: () => "revision", syncRoutes: () => {
        }, inspectSource: async (_b, token) => ({
            credentialSource: "provided", explicitTokenSource: "instance", nativeConfigMatches: false, configuredValueMatches: token === "ORIGINAL"
        }), writeRoute: async () => {
            writes++;
            throw new Error("uncertain");
        }, resolveRouteMutation: async () => {
            throw new Error("still uncertain");
        }
    };
    const prepared = await prepareNapcatWebuiTokenCommit(ports, binding, "original"), result = await prepared.commit("NEW");
    assert.equal(result.state, "uncertain");
    result.assertCurrent();
    assert.equal(writes, 1);
    route.napcatInstances![0]!.botUserId = "23456";
    assert.throws(result.assertCurrent);
});
test("native config-source token uses the original config readback without creating any Route/vault copy", async () => {
    const route = {
        id: "route", enabled: true, messageAdapters: ["napcat"], napcatInstances: [{ id: "instance", botUserId: "12345" }]
    } as GatewayDefinition;
    let readback = false;
    const binding = {
        routeId: "route", instanceId: "instance", expectedUserId: "12345", assertCurrent: () => {
        }
    };
    const ports: NapcatWebuiTokenCommitPorts = {
        assertCurrent: () => {
        }, readRoutes: () => [route], routeVersion: () => "same", syncRoutes: () => {
        }, writeRoute: async () => {
            throw new Error("Config source must not create a Route credential");
        }, resolveRouteMutation: async () => {
            throw new Error("No Route mutation exists");
        }, inspectSource: async (_b, token) => ({
            credentialSource: "config", nativeConfigMatches: readback && token === "NEW", configuredValueMatches: false
        })
    };
    const prepared = await prepareNapcatWebuiTokenCommit(ports, binding, "native-only");
    readback = true;
    const result = await prepared.commit("NEW");
    assert.equal(result.state, "committed");
    assert.equal(route.napcatInstances![0]!.webuiToken, undefined);
});

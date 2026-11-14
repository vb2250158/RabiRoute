import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assertCurrentRemoteSurface, assertRetiredGatewayFields, retiredGatewayFields, missingSharedFields } from './config-surface-contract.mjs';
import { build } from 'esbuild';
import { GATEWAY_JSON_FIELDS, GATEWAY_SCALAR_FIELDS } from '../utils/config-surface.js';
const root=path.resolve(import.meta.dirname,'../../..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
const input={webgui:read('src/plugins/io.rabiroute.manager.message-adapter-control/web/pages/RouteConfigPage.vue'),aiui:read('apps/rabilink-aiui/utils/config-surface.js'),shared:read('src/shared/gatewayConfigModel.ts'),runtime:read('src/manager/controlPlaneRoutes.ts'),owner:read('apps/rabilink-aiui/utils/device-agent-page.js')};
test('current instance bindings and preserved defaults are explicit',()=>assertCurrentRemoteSurface(input));
test('removing current UI binding fails',()=>assert.throws(()=>assertCurrentRemoteSurface({...input,webgui:input.webgui.replaceAll(':instance="target.instance"','')}),/Missing current remote UI binding/));
test('unknown shared schema field is not exempted as compatibility',()=>assert.deepEqual(missingSharedFields(['unknownNewSchemaField'],new Set([...GATEWAY_JSON_FIELDS,...GATEWAY_SCALAR_FIELDS].map(f=>f.key))),['unknownNewSchemaField']));

test('retired fields are actually removed by the shared save normalizer and absent from editors', async () => {
  const bundle = await build({ entryPoints: [path.join(root, 'src/shared/gatewayConfigModel.ts')], bundle: true, write: false, format: 'esm', platform: 'node' });
  const model = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  assertRetiredGatewayFields(model.normalizeGatewayDefinition);
  const exposed = new Set([...GATEWAY_JSON_FIELDS, ...GATEWAY_SCALAR_FIELDS].map(field => field.key));
  for (const field of retiredGatewayFields) assert.equal(exposed.has(field), false, `${field} must not appear editable`);
  assert.throws(() => assertRetiredGatewayFields(value => value), /Retired field is still saved/);
});

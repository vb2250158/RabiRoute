export * from './computer-control-contract.mjs';
/** Protocol facts shared by the remote executors, Manager replay owner and API contracts. */
export const TERMINAL_LIMITS = Object.freeze({ idPattern: "^[a-f0-9-]{36}$", inputBytes: 16384, eventCodeUnits: 16384,
  replayBytes: 262144, replayEvents: 2048, waitMs: 25000, transportSessions: 128,
  retainedSessions: 64, inputReceipts: 256, inputQueueBytes: 65536,
  minCols: 20, maxCols: 400, minRows: 5, maxRows: 200, streamQueueBytes: 524288, heartbeatMs: 25000 });
export const COMPUTER_LIMITS = Object.freeze({ chunkBytes: 65536, chunkBase64CodeUnits: 87384, uploadBytes: Number.MAX_SAFE_INTEGER,
  uploadIdPattern: TERMINAL_LIMITS.idPattern, hashPattern: "^[a-f0-9]{64}$" });
const text = { type: "string" }, integer = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, bool = { type: "boolean" };
export const terminalIdSchema = { type: "string", pattern: TERMINAL_LIMITS.idPattern };
const hash = { type: "string", pattern: COMPUTER_LIMITS.hashPattern };
const exact = properties => ({ type: "object", required: Object.keys(properties), properties, additionalProperties: false });
const branch = (action, required, properties = {}) => ({ type: "object", required: ["action", ...required],
  properties: { action: { const: action }, ...properties }, additionalProperties: true });
export const terminalRequestSchema = { anyOf: [branch("list", []),
  branch("open", ["terminalId", "shell"], { terminalId: terminalIdSchema, shell: text, cwd: { description: "A falsey value uses the remote default; otherwise the executor requires an existing absolute directory." } }),
  ...["get", "close"].map(action => branch(action, ["terminalId"], { terminalId: terminalIdSchema })),
  branch("input", ["terminalId", "sequence", "data"], { terminalId: terminalIdSchema, sequence: { ...integer, minimum: 1 }, data: text }),
  branch("resize", ["terminalId", "cols", "rows"], { terminalId: terminalIdSchema,
    cols: { type: "integer", minimum: TERMINAL_LIMITS.minCols, maximum: TERMINAL_LIMITS.maxCols }, rows: { type: "integer", minimum: TERMINAL_LIMITS.minRows, maximum: TERMINAL_LIMITS.maxRows } })
] };
export const terminalSnapshotSchema = { type: "object", required: ["terminalId", "shell", "cwd", "state", "createdAt", "nextInputSequence"],
  properties: { terminalId: terminalIdSchema, shell: text, cwd: text, state: { enum: ["starting", "running", "closing", "exited"] }, createdAt: text,
    nextInputSequence: { ...integer, minimum: 1 }, pid: integer, exitCode: { anyOf: [{ type: "integer" }, { type: "null" }] } }, additionalProperties: false };
export const terminalListSchema = exact({ shells: { type: "array", items: text }, sessions: { type: "array", items: terminalSnapshotSchema } });
export const terminalEventSchema = { type: "object", required: ["sequence", "type"], properties: { sequence: integer,
  type: { enum: ["output", "exit", "gap", "disconnected"] }, data: text, exitCode: { anyOf: [{ type: "integer" }, { type: "null" }] } }, additionalProperties: false };
export const terminalReadSchema = exact({ terminal: terminalSnapshotSchema, outputEvents: { type: "array", maxItems: TERMINAL_LIMITS.replayEvents, items: terminalEventSchema }, nextOutputSequence: integer, truncated: bool });
const fileFields = { path: text }, uploadId = terminalIdSchema;
const point = { type: 'object', required: ['x', 'y'], properties: { x: { type: 'number' }, y: { type: 'number' } }, additionalProperties: false };
export const computerSourceSchema = { type: 'object', required: ['instanceId', 'kind', 'coordinateSpace'], properties: {
  instanceId: text, kind: { enum: ['desktop', 'window'] }, windowId: text, pid: integer, frameId: text,
  coordinateSpace: { enum: ['desktop', 'capture'] }, width: { type: 'number', exclusiveMinimum: 0 }, height: { type: 'number', exclusiveMinimum: 0 },
  bounds: { type: 'object', required: ['x','y','width','height'], properties: { x: {type:'number'}, y: {type:'number'}, width: {type:'number',exclusiveMinimum:0}, height: {type:'number',exclusiveMinimum:0} }, additionalProperties:false }
}, additionalProperties: true };
const action = (type, required, properties) => ({ type: 'object', required: ['type', ...required], properties: { type: { const: type }, ...properties }, additionalProperties: false });
const xy = { x: {type:'number'}, y: {type:'number'} };
export const computerInputActionSchema = { anyOf: [
  action('move', ['x','y'], xy), action('click', ['x','y'], { ...xy, button: {enum:['left','right','middle']}, count: {type:'integer',minimum:1,maximum:2} }),
  action('scroll', [], { deltaX: {type:'number',description:'Wheel ticks; the Windows executor converts one tick to 120 units.'}, deltaY: {type:'number'}, ...xy }),
  action('drag', ['x','y','toX','toY'], { ...xy, toX:{type:'number'},toY:{type:'number'},button:{enum:['left','right','middle']},durationMs:integer }),
  action('text', ['text'], {text}), action('key', ['keys'], {keys:{type:'array',minItems:1,items:text}})
] };
export const computerAnnotationShapeSchema = { type: 'object', required: ['id','type'], properties: { id:text,
  type:{enum:['rect','ellipse','arrow','path','text','highlight']}, bounds: computerSourceSchema.properties.bounds,
  points:{type:'array',items:point}, text, style:{type:'object',properties:{color:text,lineWidth:{type:'number',minimum:0},fontSize:{type:'number',exclusiveMinimum:0},opacity:{type:'number',minimum:0,maximum:1}},additionalProperties:true}
},additionalProperties:true };
export const computerTrackingTargetSchema = { type: 'object', required: ['id','bounds'], properties: { id: text, bounds: computerSourceSchema.properties.bounds, description: text, label: text }, additionalProperties: true };
const requestId = text, controlSessionId = text, layerId = text, trackingId = text;
const observation = { source: computerSourceSchema, captureAfter: bool };
export const computerControlRequestBranches = [
  branch('control.begin',['requestId'],{requestId,...observation}), branch('control.status',[],{controlSessionId}), branch('control.end',['controlSessionId'],{controlSessionId,requestId}),
  branch('input.execute',['requestId','controlSessionId','actions'],{requestId,controlSessionId,actions:{type:'array',minItems:1,items:computerInputActionSchema},...observation}),
  branch('input.status',['requestId'],{requestId}), branch('input.cancel',['requestId'],{requestId}),
  branch('annotation.show',['requestId','source','layerId','objects'],{requestId,layerId,source:computerSourceSchema,objects:{type:'array',items:computerAnnotationShapeSchema},durationMs:{anyOf:[integer,{type:'null'}]},controlSessionId}),
  branch('annotation.update',['layerId','expectedVersion'],{requestId,layerId,expectedVersion:integer,source:computerSourceSchema,objects:{type:'array',items:computerAnnotationShapeSchema},durationMs:{anyOf:[integer,{type:'null'}]}}),
  branch('annotation.status',[],{layerId}), branch('annotation.clear',[],{layerId,requestId}),
  branch('annotation.track.start',['requestId','source','layerId','targets','taskId'],{requestId,layerId,source:computerSourceSchema,targets:{type:'array',minItems:1,items:computerTrackingTargetSchema},backend:{enum:['kcf','template']},rateHz:{type:'number',exclusiveMinimum:0},taskId:text,expiresAt:{anyOf:[{type:'string',format:'date-time'},{type:'null'}]}}),
  branch('annotation.track.status',['trackingId'],{trackingId}), branch('annotation.track.stop',['trackingId'],{trackingId})
];
export const computerRequestSchema = { anyOf: [...computerControlRequestBranches, branch("file.stat", ["path"], fileFields),
  branch("file.read", ["path", "version", "offset"], { ...fileFields, version: text, offset: integer }),
  branch("upload.begin", ["uploadId", "path", "size", "sha256"], { ...fileFields, uploadId, size: { ...integer, maximum: COMPUTER_LIMITS.uploadBytes }, sha256: hash }),
  branch("upload.write", ["uploadId", "offset", "data", "sha256"], { uploadId, offset: integer,
    data: { type: "string", maxLength: COMPUTER_LIMITS.chunkBase64CodeUnits, pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$" }, sha256: hash }),
  ...["upload.commit", "upload.status", "upload.abort"].map(action => branch(action, ["uploadId"], { uploadId })),
  branch("windows.list", [], { limit: { description: "The native Windows helper applies Convert.ToInt32 and its 1..200 bound." }, query: { description: "The Windows helper applies Convert.ToString and its UTF-16 length bound." } }),
  branch("screen.capture", [], { maxWidth: { description: "The Windows helper applies Convert.ToInt32 and its 320..3840 bound." },
    windowId: { description: "If supplied, the native helper validates the hexadecimal window handle and requires its queried pid." }, pid: {} })
] };
const bounds = exact({ x: { type: "integer" }, y: { type: "integer" }, width: { type: "integer" }, height: { type: "integer" } });
export const computerResponseSchema = { anyOf: [
  exact({ path: text, size: integer, version: text, chunkBytes: { const: COMPUTER_LIMITS.chunkBytes } }),
  exact({ path: text, version: text, offset: integer, nextOffset: integer, size: integer, eof: bool, data: text, sha256: hash }),
  exact({ uploadId, path: text, size: integer, sha256: hash, offset: integer, state: { enum: ["uploading", "committed", "aborted"] } }),
  exact({ uploadId, state: { const: "absent" } }),
  exact({ windows: { type: "array", items: exact({ windowId: text, pid: integer, title: text, minimized: bool, bounds }) }, truncated: bool }),
  { type: "object", required: ["mimeType", "width", "height", "bounds", "capturedAt", "data"], additionalProperties: true, properties: { frameId: text, source: computerSourceSchema, mimeType: { const: "image/png" }, width: { ...integer, minimum: 1 }, height: { ...integer, minimum: 1 }, bounds, capturedAt: text, data: text } },
  exact({layers:{type:"array",items:{type:"object",required:["layerId","state"],properties:{layerId,state:text,version:integer},additionalProperties:true}}}),
  { type: "object", required: ["state"], properties: { status: text, state: text, requestId, controlSessionId, layerId, trackingId }, additionalProperties: true }
] };
function freeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } }
for (const value of [terminalIdSchema, terminalRequestSchema, terminalSnapshotSchema, terminalListSchema, terminalEventSchema, terminalReadSchema, computerRequestSchema, computerResponseSchema]) freeze(value);

function computerRequestSchemaForDefinitionImpl(definition) {
  const schema=structuredClone(computerRequestSchema);
  const visit=node=>{
    if(!node||typeof node!=="object")return;
    const action=node.properties?.action?.const??(node.properties?.action?.enum?.length===1?node.properties.action.enum[0]:undefined);
    if(action)for(const [name,path]of Object.entries(definition.actions[action]?.inputSettings??{})){
      let selected=definition.validationSchema;
      for(const key of String(path).split("."))selected=selected?.properties?.[key];
      if(!selected)throw new TypeError("Invalid input settings binding: "+action+"."+name);
      node.properties[name]=structuredClone(selected);
    }
    for(const value of Object.values(node))if(value&&typeof value==="object")if(Array.isArray(value))value.forEach(visit);else visit(value);
  };
  visit(schema);return schema;
}
export const computerRequestSchemaForDefinition = computerRequestSchemaForDefinitionImpl;

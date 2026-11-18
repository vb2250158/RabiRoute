import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {VideoProjects} from './projects.mjs';
test('projects survive service recreation, creation retries and concurrent save conflicts',async t=>{
  const stateRoot=await fs.mkdtemp(path.join(os.tmpdir(),'rabi-projects-'));
  t.after(()=>fs.rm(stateRoot,{recursive:true,force:true}));
  const store=new VideoProjects({stateRoot}),id=randomUUID();
  await store.create({id});assert.equal((await store.create({id})).revision,0);
  const value={version:1,active:'v1',items:[{id:'v1',kind:'video',text:'saved prompt'}],drafts:[]};
  const saves=await Promise.allSettled([store.save(id,{revision:0,value,title:'作品'}),store.save(id,{revision:0,value,title:'stale'})]);
  assert.equal(saves.filter(row=>row.status==='fulfilled').length,1);
  const restored=new VideoProjects({stateRoot});
  assert.equal((await restored.read(id)).value.items[0].text,'saved prompt');
  assert.equal((await restored.list())[0].title,'作品');
  const other=randomUUID();await restored.create({id:other});
  await restored.save(other,{revision:0,value:{...value,items:[{id:'v1',kind:'video',text:'other project'}]}});
  assert.equal((await restored.read(id)).value.items[0].text,'saved prompt');
  assert.equal((await restored.read(other)).value.items[0].text,'other project');
  await assert.rejects(restored.read('../escape'),/项目不存在/);
  assert.throws(()=>new VideoProjects({stateRoot,readOnly:true}).save(id,{revision:1,value}),/只读/);
});

test('project cards display existing media previews and distinguish workflow counts', async t => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rabi-project-previews-'));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const projects = new VideoProjects({ stateRoot });
  const legacyId = randomUUID();
  const assetId = randomUUID();
  const draft = { version: 1, active: 'video-1', drafts: [], items: [
    { id: 'video-1', kind: 'video', asset: { id: assetId, kind: 'video' }, text: 'private prompt' }
  ] };
  await projects.create({ id: legacyId });
  await projects.save(legacyId, { revision: 0, title: 'Existing video', value: draft });
  const media = await projects.createProjectV2({ id: randomUUID() });
  await projects.saveMediaEditor(media.id, media.defaultCanvasId, {
    revision: 0, title: 'Edited media project', value: draft
  });
  const workflow = await projects.createProjectV2({ id: randomUUID(), title: 'Workflow project' });
  const canvas = await projects.readCanvas(workflow.id, workflow.defaultCanvasId);
  canvas.graph.nodes.push({ id: 'review', kind: 'human', title: 'Review', config: {} });
  await projects.saveCanvas(workflow.id, canvas.id, canvas);
  const summaries = new Map((await new VideoProjects({ stateRoot }).list()).map(project => [project.id, project]));
  assert.equal(summaries.get(legacyId).preview.assetId, assetId);
  assert.equal(summaries.get(media.id).title, 'Edited media project');
  assert.equal(summaries.get(media.id).preview.assetId, assetId);
  assert.equal(summaries.get(workflow.id).cardCount, 1);
  assert.equal(summaries.get(workflow.id).mediaEditor, false);
  assert.ok(!JSON.stringify([...summaries.values()]).includes('private prompt'));
});

test('a flow node and media edits share a canvas without losing the video preview or prompt', async t => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rabi-mixed-canvas-'));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const store = new VideoProjects({ stateRoot });
  const project = await store.createProjectV2({ id: randomUUID() });
  const canvasId = project.defaultCanvasId;
  const videoId = randomUUID();
  const assetId = randomUUID();
  const firstVideo = { id: videoId, kind: 'video', asset: { id: assetId, kind: 'video' }, text: '' };
  const draft = { version: 1, active: videoId, drafts: [[videoId, { prompt: 'first prompt' }]], items: [firstVideo], positions: { [videoId]: { x: 120, y: 90 } } };
  await store.saveMediaEditor(project.id, canvasId, { revision: 0, value: draft, title: 'Mixed canvas' });
  const graph = await store.readCanvas(project.id, canvasId);
  const node = { id: randomUUID(), kind: 'human', title: 'Review', config: {}, layout: { x: 620, y: 90 } };
  graph.graph.nodes.push(node);
  await store.saveCanvas(project.id, canvasId, graph);
  const media = await store.readMediaEditor(project.id, canvasId);
  media.value.drafts[0][1].prompt = 'edited prompt';
  await store.saveMediaEditor(project.id, canvasId, media);
  const afterMedia = await store.readCanvas(project.id, canvasId);
  afterMedia.graph.nodes.find(row => row.id === node.id).layout = { x: 840, y: 90 };
  await store.saveCanvas(project.id, canvasId, afterMedia);
  const restored = new VideoProjects({ stateRoot });
  const reopened = await restored.readMediaEditor(project.id, canvasId);
  assert.equal(reopened.value.drafts[0][1].prompt, 'edited prompt');
  assert.equal(reopened.value.items[0].asset.id, assetId);
  assert.deepEqual((await restored.readCanvas(project.id, canvasId)).graph.nodes.find(row => row.id === node.id).layout, { x: 840, y: 90 });
  const audio = { id: randomUUID(), kind: 'audio', text: 'voice only' };
  await restored.saveMediaEditor(project.id, canvasId, { revision: reopened.revision, value: { version: 1, active: '', drafts: [], items: [audio] } });
  const audioDraft = (await restored.readMediaEditor(project.id, canvasId)).value;
  assert.equal(audioDraft.active, '');
  assert.deepEqual(audioDraft.items, [audio]);
});

test('automatic upgrade keeps the original media as the first canvas and joins multiple content inputs', async t => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rabi-auto-workspace-'));
  t.after(() => fs.rm(stateRoot, { recursive: true, force: true }));
  const store = new VideoProjects({ stateRoot });
  const projectId = randomUUID();
  const assetId = randomUUID();
  const items = [
    { id: 'v1', kind: 'video', title: 'Video', asset: { id: assetId, kind: 'video' }, text: '' },
    { id: 't1', kind: 'text', title: 'Text 1', text: 'subject' },
    { id: 't2', kind: 'text', title: 'Text 2', text: 'setting' }
  ];
  const value = { version: 1, active: 'v1', items, drafts: [['v1', { prompt: 'motion' }]], positions: { v1: { x: 50, y: 30 } } };
  await store.create({ id: projectId });
  const original = await store.save(projectId, { revision: 0, title: 'Original project', value });
  const migrated = await store.migrateProject(projectId, { automatic: true });
  assert.equal((await store.migrateProject(projectId, { automatic: true })).defaultCanvasId, migrated.defaultCanvasId);
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.listCanvases(projectId)).canvases.length, 1);
  const canvas = await store.readCanvas(projectId, migrated.defaultCanvasId);
  assert.equal(canvas.name, original.title);
  const savedDraft = await store.readMediaEditor(projectId, canvas.id);
  assert.equal(savedDraft.value.items[0].asset.id, assetId);
  assert.equal(savedDraft.value.drafts[0][1].prompt, 'motion');
  assert.deepEqual(savedDraft.value.positions.v1, { x: 50, y: 30 });
  const mediaLinks = [{ from: 't1', to: 'v1' }, { from: 't2', to: 'v1' }];
  const withLinks = await store.saveCanvas(projectId, canvas.id, { ...canvas, mediaLinks });
  assert.deepEqual((await store.readCanvas(projectId, canvas.id)).mediaLinks, mediaLinks);
  await assert.rejects(store.saveCanvas(projectId, canvas.id, { ...withLinks, mediaLinks: [{ from: 't1', to: 't2' }, { from: 't2', to: 't1' }] }), /循环/);
  const reloaded = await store.readMediaEditor(projectId, canvas.id);
  reloaded.value.items = reloaded.value.items.filter(item => item.id !== 't1');
  await store.saveMediaEditor(projectId, canvas.id, reloaded);
  assert.deepEqual((await store.readCanvas(projectId, canvas.id)).mediaLinks, [mediaLinks[1]]);
});

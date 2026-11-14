/** Pure Persona update preparation. The original storage service owns publication and shared state. */
export function createPlanUpdatePreparation(ports) {
  return Object.freeze({
    prepare({ roleDir, existing, patch, workflow, recordedAt, mutation }) {
      if (existing.archiveStatus === '已归档') {
        throw new Error(`Archived plans are immutable terminal records: ${existing.id}`);
      }
      if (Object.hasOwn(patch, 'status')) ports.validatePlanStatusInput(workflow, patch.status);
      const state = ports.planStateForWrite(patch, existing, workflow);
      ports.validatePlanStatusInput(workflow, state.markerStatus);
      if (Object.hasOwn(patch, 'archiveStatus')
        && patch.archiveStatus !== '未归档' && patch.archiveStatus !== '已归档') {
        throw new Error('Unsupported plan archiveStatus. Use 未归档 or 已归档.');
      }
      if (Object.hasOwn(patch, 'secretaryBinding')) ports.validatePlanSecretaryBindingInput(patch.secretaryBinding);
      if (Object.hasOwn(patch, 'taskBinding')) ports.validatePlanTaskBindingInput(patch.taskBinding);
      if (Object.hasOwn(patch, 'messageChannels')) ports.validatePlanMessageChannels(patch.messageChannels);
      const clearedStartedAt = ports.planStepIdsWithClearedTime(patch.steps, 'startedAt');
      const clearedCompletedAt = ports.planStepIdsWithClearedTime(patch.steps, 'completedAt');
      const next = ports.normalizePlan({
        ...existing,
        ...patch,
        ...state,
        attachments: existing.attachments,
        id: existing.id,
        createdAt: existing.createdAt,
        updatedAt: recordedAt,
        storageRevision: mutation?.revision ?? ports.createStorageRevision(),
        storageMutationRequestId: mutation?.requestId
      });
      if (!next) throw new Error('Plan title is required.');
      for (const step of next.steps) {
        const previous = existing.steps.find(item => item.id === step.id)?.resourceRecords;
        if (!previous?.length) continue;
        const records = new Map(previous.map(item => [item.id, item]));
        for (const item of step.resourceRecords || []) {
          const prior = records.get(item.id);
          if (prior && JSON.stringify(prior) !== JSON.stringify(item)) {
            throw new Error(`Step resource record is immutable: ${item.id}.`);
          }
          records.set(item.id, item);
        }
        step.resourceRecords = [...records.values()];
      }
      next.steps = ports.recordPlanStepTimes(
        next.steps, existing.steps, next.currentStepId, recordedAt,
        clearedStartedAt, clearedCompletedAt
      );
      ports.requireKeywords(next.keywords, 'Plan');
      ports.validatePlanWrite(roleDir, next);
      if (next.activationStatus === '已完成'
        && existing.activationStatus !== '已完成' && !next.completedAt) {
        next.completedAt = next.updatedAt;
      }
      if (next.activationStatus === '已归档' && !next.archivedAt) next.archivedAt = next.updatedAt;
      return next;
    },
    projectHistory({ roleDir, sourcePlan, next, currentBucket, destinationBucket, mutation }) {
      const before = currentBucket === destinationBucket
        ? sourcePlan
        : ports.rewritePlanStoragePaths(sourcePlan, [{
          from: ports.planDirectory(roleDir, next.id, currentBucket),
          to: ports.planDirectory(roleDir, next.id, destinationBucket)
        }]);
      return ports.createPlanHistoryRecord(before, next, mutation?.actor);
    },
    projectPlan({ plan, approval, revision }) {
      return { plan, approval, revision };
    }
  });
}

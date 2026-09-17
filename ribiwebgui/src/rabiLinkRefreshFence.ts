/** Reject stale reads, including reads started before an identity mutation. */
export function createRabiLinkRefreshFence() {
  let revision = 0;
  let saving = false;
  return {
    setSaving(value: boolean) { saving = value; revision += 1; },
    begin(): number | undefined { return saving ? undefined : ++revision; },
    accepts(value: number): boolean { return !saving && value === revision; }
  };
}

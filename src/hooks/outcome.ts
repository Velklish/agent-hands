export type HookOutcome = { owner: string; event: string; ok: true; exitStatus: 0 }
  | { owner: string; event: string; ok: false; exitStatus: number | null };

/** Normalize the status of one invocation already completed by the host. */
export function workspaceHookOutcome(owner: string, event: string, exitStatus: number | null): HookOutcome {
  if (!owner || !event || (exitStatus !== null && (!Number.isSafeInteger(exitStatus) || exitStatus < 0))) throw new TypeError('Invalid hook outcome');
  return exitStatus === 0 ? {owner,event,ok:true,exitStatus} : {owner,event,ok:false,exitStatus};
}

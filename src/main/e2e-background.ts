// Require both a test launch and an explicit E2E flag so a normal launch
// cannot accidentally hide the application.
export function isE2eBackground(env: NodeJS.ProcessEnv): boolean {
  return env['NODE_ENV'] === 'test' && env['STATEKEEP_E2E_BACKGROUND'] === '1'
}

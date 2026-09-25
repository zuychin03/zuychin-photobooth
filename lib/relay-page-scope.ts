export function createRelayPageScope() {
  let generation = 0, active = false;
  return {
    activate() { active = true; const current = ++generation; return () => { if (generation === current) { active = false; generation++; } }; },
    capture() { const current = generation; return () => active && generation === current; },
  };
}

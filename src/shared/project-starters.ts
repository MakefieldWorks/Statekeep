/** Stable identifiers and user-facing metadata; bundled into every app build. */
export const PROJECT_STARTERS = [
  { id: 'lab', version: 1, name: 'Test Lab', description: 'Track instruments, firmware, and calibration in a working test facility.', structure: 'Systems Room → Rack A → Instruments', exercise: 'Compare baseline with configuration-update to see a firmware update and a new instrument. Edit an instrument, then save your own snapshot.' },
  { id: 'network', version: 1, name: 'Network Equipment', description: 'Track sites, racks, switches, and software revisions.', structure: 'Main Office → Network Rack → Switches', exercise: 'Compare baseline with configuration-update to inspect a switch upgrade. Change a device owner, then snapshot and compare your work.' },
  { id: 'maintenance', version: 1, name: 'Equipment Maintenance', description: 'Track assets, service dates, and replaceable components.', structure: 'Workshop → Equipment → Components', exercise: 'Compare baseline with configuration-update to inspect a completed service. Update a service date, then snapshot and compare your work.' },
] as const

export type ProjectStarterId = typeof PROJECT_STARTERS[number]['id']

#!/usr/bin/env node
// Liftoff workouts → a Strong CSV, for any app that imports Strong (openGym among them).
//
//   liftoff-export workouts list --format json > liftoff.json
//   node scripts/liftoff-to-strong.ts liftoff.json > strong.csv
//   liftoff-export workouts list --format json | node scripts/liftoff-to-strong.ts --unit lb
//
// The input is what github.com/quantcli/liftoff-export-cli prints for `workouts list --format
// json`: an array of posts (cmd/workouts.go, Post / ExerciseData / SetData). Two facts from its
// README decide the conversion:
//   - every weight is pounds (Liftoff turns kilograms into pounds and does not say which it was);
//   - what inputOne and inputTwo mean depends on the exercise's exerciseTypes:
//       WR weight, reps          BR added load, reps      AB assistance, reps
//       WD weight, distance km   DD distance km, seconds  ND (unused), seconds
//
// The output is Strong's export: Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,
// Distance,Seconds,Notes,Workout Notes,RPE. Strong has no unit column, so the weights are written
// in --unit (kg by default, rounded to 0.01 kg, which gives kilogram-entered sets back exactly)
// and the importing app is told the unit by its own settings. Distances stay in km.
//
// Options: --unit kg|lb, --name "Workout name" (Liftoff posts have none; default "Liftoff"),
// --tz Area/City (the zone dates are written in; default this computer's), -o file.
// Sets of an exerciseTypes code this does not know are left out and counted on stderr.
//
// Plain TypeScript that Node runs as it is (type stripping, Node 22.18 or later): no build step.
import fs from 'node:fs'

type SetData = { setIndex?: number, setType?: string, inputOne?: number | string | null, inputTwo?: number | string | null }
type ExerciseData = { exerciseName?: string, exerciseTypes?: string, exerciseNotes?: string, setsData?: SetData[] }
type Post = {
  id?: string, startedAt?: string, sessionDuration?: string, sessionDurationSeconds?: number | null,
  sessionNotes?: string, exerciseData?: ExerciseData[]
}
export type Options = { unit?: 'kg' | 'lb', name?: string, tz?: string }

const LB_PER_KG = 2.20462262185
export const HEADER = ['Date', 'Workout Name', 'Duration', 'Exercise Name', 'Set Order', 'Weight', 'Reps', 'Distance', 'Seconds', 'Notes', 'Workout Notes', 'RPE']

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  return Number.isFinite(n) ? n : 0
}
// Up to two decimals, no trailing zeros: 22.0462262185 lb → 10 (kg), 60.5 → 60.5.
const short = (n: number): string => String(Math.round(n * 100) / 100)
const quote = (s: string): string => '"' + s.replace(/"/g, '""') + '"'

// "01 hours 06 minutes 01 seconds", or the CLI's own sessionDurationSeconds.
export function seconds(p: Post): number {
  if (typeof p.sessionDurationSeconds === 'number' && Number.isFinite(p.sessionDurationSeconds)) return p.sessionDurationSeconds
  const f = String(p.sessionDuration || '').toLowerCase().split(/\s+/).filter(Boolean)
  let total = 0
  for (let i = 0; i + 1 < f.length; i += 2) {
    const n = parseInt(f[i], 10), u = f[i + 1].replace(/s$/, '')
    if (!Number.isFinite(n)) return 0
    total += u === 'hour' ? n * 3600 : u === 'minute' ? n * 60 : u === 'second' ? n : 0
  }
  return total
}

// Strong's Duration: "1h 5m", "52m".
export function strongDuration(sec: number): string {
  const m = Math.round(sec / 60), h = Math.floor(m / 60)
  return h ? `${h}h ${m % 60}m` : `${m}m`
}

// "2026-06-11 05:14:12", the wall clock in `tz`, as Strong writes it.
export function strongDate(iso: string, tz?: string): string | null {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms)).map(p => [p.type, p.value]))
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`
}

type Values = { weightLb: number, reps: number, km: number, sec: number }
function values(type: string, s: SetData): Values | null {
  const one = num(s.inputOne), two = num(s.inputTwo)
  switch (type.toUpperCase()) {
    case 'WR': case 'BR': case 'AB': return { weightLb: one, reps: Math.round(two), km: 0, sec: 0 }
    case 'WD': return { weightLb: one, reps: 0, km: two, sec: 0 }
    case 'DD': return { weightLb: 0, reps: 0, km: one, sec: Math.round(two) }
    case 'ND': return { weightLb: 0, reps: 0, km: 0, sec: Math.round(two) }
    default: return null
  }
}

// Strong numbers the working sets 1, 2, 3 and marks the others W (warm-up), D (drop), F (failure).
function setOrder(setType: string | undefined, n: number): string {
  const t = String(setType || '')
  return /warm/i.test(t) ? 'W' : /drop/i.test(t) ? 'D' : /fail/i.test(t) ? 'F' : String(n)
}

/** posts → { csv, rows, skipped }. */
export function liftoffToStrong(posts: unknown, opts: Options = {}): { csv: string, rows: number, skipped: number } {
  if (!Array.isArray(posts)) throw new Error('expected the JSON array that `liftoff-export workouts list --format json` prints')
  const unit = opts.unit === 'lb' ? 'lb' : 'kg'
  const name = opts.name || 'Liftoff'
  const weight = (lb: number) => short(unit === 'kg' ? lb / LB_PER_KG : lb)
  const lines = [HEADER.join(',')]
  let skipped = 0
  const sorted = (posts as Post[]).filter(p => p && typeof p.startedAt === 'string')
    .sort((a, b) => Date.parse(a.startedAt as string) - Date.parse(b.startedAt as string))
  skipped += (posts as unknown[]).length - sorted.length
  for (const p of sorted) {
    const date = strongDate(p.startedAt as string, opts.tz)
    if (!date) { skipped++; continue }
    const duration = strongDuration(seconds(p))
    for (const e of Array.isArray(p.exerciseData) ? p.exerciseData : []) {
      const type = String(e?.exerciseTypes || '')
      let exercise = String(e?.exerciseName || '').trim()
      if (!exercise || !Array.isArray(e.setsData)) { skipped++; continue }
      // Strong keeps assisted movements apart by name, with the assistance as the weight.
      if (type.toUpperCase() === 'AB' && !/assist/i.test(exercise)) exercise += ' (Assisted)'
      const sets = [...e.setsData].sort((a, b) => num(a?.setIndex) - num(b?.setIndex))
      let n = 0, first = true
      for (const s of sets) {
        const v = values(type, s)
        if (!v) { skipped++; continue }
        const order = setOrder(s.setType, /warm|drop|fail/i.test(String(s.setType || '')) ? n : ++n)
        lines.push([
          date, quote(name), duration, quote(exercise), order,
          weight(v.weightLb), v.reps, short(v.km), v.sec,
          quote(first ? String(e.exerciseNotes || '') : ''), quote(String(p.sessionNotes || '')), '',
        ].join(','))
        first = false
      }
    }
  }
  return { csv: lines.join('\n') + '\n', rows: lines.length - 1, skipped }
}

function main(argv: string[]) {
  const opts: Options = {}
  let input = '-', output = ''
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--unit') { const u = argv[++i]; if (u !== 'kg' && u !== 'lb') throw new Error('--unit is kg or lb'); opts.unit = u }
    else if (a === '--name') opts.name = argv[++i]
    else if (a === '--tz') opts.tz = argv[++i]
    else if (a === '-o' || a === '--output') output = argv[++i]
    else if (a === '-h' || a === '--help') { process.stdout.write('usage: node scripts/liftoff-to-strong.ts [liftoff.json|-] [--unit kg|lb] [--name NAME] [--tz ZONE] [-o strong.csv]\n'); return }
    else input = a
  }
  const text = fs.readFileSync(input === '-' ? 0 : input, 'utf8')
  const { csv, rows, skipped } = liftoffToStrong(JSON.parse(text), opts)
  if (output) fs.writeFileSync(output, csv)
  else process.stdout.write(csv)
  process.stderr.write(`${rows} sets written${skipped ? `, ${skipped} left out (no date, no exercise name or an unknown exerciseTypes)` : ''}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(process.argv.slice(2)) }
  catch (e) { process.stderr.write(`liftoff-to-strong: ${(e as Error).message}\n`); process.exit(1) }
}

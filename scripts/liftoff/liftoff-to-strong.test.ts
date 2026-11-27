// node --test scripts/liftoff/liftoff-to-strong.test.ts
// The sample converts to the CSV beside it, and openGym's own importer reads that CSV as Strong
// with the weights, warm-ups, timed and cardio sets where they belong.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { liftoffToStrong, strongDuration, strongDate } from '../liftoff-to-strong.ts'
import { parseWorkoutCSV } from '../../frontend/src/lib/import-csv.js'

const here = new URL('.', import.meta.url)
const posts = JSON.parse(fs.readFileSync(new URL('sample-workouts.json', here), 'utf8'))
const expected = fs.readFileSync(new URL('sample-strong.csv', here), 'utf8')

test('the sample gives sample-strong.csv', () => {
  const { csv, rows, skipped } = liftoffToStrong(posts, { tz: 'Europe/Zurich' })
  assert.equal(csv, expected)
  assert.equal(rows, 10)
  assert.equal(skipped, 0)
})

test('kilogram-entered sets come back as whole kilograms; --unit lb keeps pounds', () => {
  assert.match(expected, /"Seated Cable Chest Press",1,50,8,/)
  const lb = liftoffToStrong(posts, { unit: 'lb', tz: 'UTC' }).csv
  assert.match(lb, /"Back Squat",1,225,5,/)
  assert.match(lb, /^2026-11-15 08:05:00,/m)
})

test('durations and dates in Strong\'s own spelling', () => {
  assert.equal(strongDuration(3912), '1h 5m')
  assert.equal(strongDuration(3160), '53m')
  assert.equal(strongDate('2026-06-11T03:14:12.665Z', 'UTC'), '2026-06-11 03:14:12')
  assert.equal(strongDate('not a date'), null)
})

test('an unknown exerciseTypes is left out, not guessed', () => {
  const r = liftoffToStrong([{ startedAt: '2026-01-01T10:00:00Z', exerciseData: [{ exerciseName: 'Mystery', exerciseTypes: 'ZZ', setsData: [{ inputOne: 1, inputTwo: 2 }] }] }])
  assert.equal(r.rows, 0)
  assert.equal(r.skipped, 1)
  assert.throws(() => liftoffToStrong({}), /JSON array/)
})

test('openGym imports the CSV as a Strong export', () => {
  const parsed = parseWorkoutCSV(expected, { unit: 'kg' })
  assert.equal(parsed.source, 'Strong')
  assert.equal(parsed.workouts.length, 2)
  const [sat, mon] = parsed.workouts
  assert.equal(sat.entries.length, 4)
  assert.equal(mon.note, 'Travel gym, kg plates')
  const sets = mon.entries.flatMap(e => [...(e.warmupSets || []), ...e.sets])
  assert.ok(sets.some(s => s.w === 50 && s.r === 8))
})

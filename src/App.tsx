import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Progress } from '@/components/ui/progress'
import { Card, CardContent } from '@/components/ui/card'

// ---------------------------------------------------------------------------
// Breadth-first merge sort — explicit state machine
//
// Instead of a generator (which can't step backward), we represent the entire
// sort as a plain data structure. Each vote is a pure function:
//   step(state, choice) → newState
//
// Undo is O(1): just pop the previous state off a history stack.
// ---------------------------------------------------------------------------

type Comparison = { left: string; right: string }
type Choice = 'left' | 'right'

type MergeJob = {
  l: string[]   // left input  (never mutated)
  r: string[]   // right input (never mutated)
  li: number    // current index into l
  ri: number    // current index into r
  out: string[] // merged output so far
}

type SortState = {
  jobs: MergeJob[]        // active merge jobs for this level
  jobIdx: number          // next job to compare (round-robin pointer)
  pendingSegs: string[][] // segments carried forward to the next level
  elo: Map<string, number>
  battled: Set<string>
  done: number
}

type StepResult =
  | { kind: 'continue'; state: SortState }
  | { kind: 'done'; result: string[] }

function getComparison(s: SortState): Comparison {
  const j = s.jobs[s.jobIdx]
  return { left: j.l[j.li], right: j.r[j.ri] }
}

// Find the next job with a comparison remaining, cycling from `from`.
function findNextActive(jobs: MergeJob[], from: number): number {
  for (let i = 0; i < jobs.length; i++) {
    const idx = (from + i) % jobs.length
    const j = jobs[idx]
    if (j.li < j.l.length && j.ri < j.r.length) return idx
  }
  return -1
}

function startLevel(
  segs: string[][],
  elo: Map<string, number>,
  battled: Set<string>,
  done: number,
): StepResult {
  if (segs.length === 1) return { kind: 'done', result: segs[0] }

  const jobs: MergeJob[] = []
  for (let i = 0; i + 1 < segs.length; i += 2) {
    jobs.push({ l: segs[i], r: segs[i + 1], li: 0, ri: 0, out: [] })
  }
  const pendingSegs = segs.length % 2 !== 0 ? [segs[segs.length - 1]] : []
  const jobIdx = findNextActive(jobs, 0)

  return { kind: 'continue', state: { jobs, jobIdx, pendingSegs, elo, battled, done } }
}

export function initSort(items: string[]): StepResult {
  return startLevel(
    items.map((x) => [x]),
    new Map(),
    new Set(),
    0,
  )
}

export function step(s: SortState, choice: Choice): StepResult {
  const j = s.jobs[s.jobIdx]
  const winner = choice === 'left' ? j.l[j.li] : j.r[j.ri]
  const loser  = choice === 'left' ? j.r[j.ri] : j.l[j.li]

  // Produce new job with one comparison resolved (immutable — new objects)
  const newJ: MergeJob = {
    ...j,
    out: [...j.out, winner],
    li: choice === 'left'  ? j.li + 1 : j.li,
    ri: choice === 'right' ? j.ri + 1 : j.ri,
  }
  const newJobs = s.jobs.map((job, i) => (i === s.jobIdx ? newJ : job))

  const newElo     = applyElo(s.elo, winner, loser)
  const newBattled = new Set([...s.battled, winner, loser])
  const newDone    = s.done + 1

  // Advance round-robin to next active job
  const nextIdx = findNextActive(newJobs, (s.jobIdx + 1) % newJobs.length)

  if (nextIdx !== -1) {
    return {
      kind: 'continue',
      state: { ...s, jobs: newJobs, jobIdx: nextIdx, elo: newElo, battled: newBattled, done: newDone },
    }
  }

  // All jobs at this level are done — drain remaining elements and start next level
  const jobSegs = newJobs.map((job) => [
    ...job.out,
    ...job.l.slice(job.li),
    ...job.r.slice(job.ri),
  ])
  return startLevel([...jobSegs, ...s.pendingSegs], newElo, newBattled, newDone)
}

// ---------------------------------------------------------------------------
// ELO — powers the live sidebar ranking
// ---------------------------------------------------------------------------
const K = 32
const BASE = 1000

function applyElo(
  ratings: Map<string, number>,
  winner: string,
  loser: string,
): Map<string, number> {
  const next = new Map(ratings)
  const wR = next.get(winner) ?? BASE
  const lR = next.get(loser) ?? BASE
  const exp = 1 / (1 + 10 ** ((lR - wR) / 400))
  next.set(winner, wR + K * (1 - exp))
  next.set(loser, lR + K * (0 - (1 - exp)))
  return next
}

function maxComparisons(n: number): number {
  if (n < 2) return 0
  return n * Math.ceil(Math.log2(n)) - n + 1
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
type Phase = 'input' | 'battle' | 'results'

export default function App() {
  const [phase, setPhase] = useState<Phase>('input')
  const [inputText, setInputText] = useState('')
  const [ranked, setRanked] = useState<string[]>([])
  const [sortState, setSortState] = useState<SortState | null>(null)
  const [history, setHistory] = useState<SortState[]>([])
  const [total, setTotal] = useState(0)

  const start = useCallback(() => {
    const list = inputText.split('\n').map((s) => s.trim()).filter(Boolean)
    if (list.length < 2) return

    setTotal(maxComparisons(list.length))
    setHistory([])
    setRanked([])

    const shuffled = [...list].sort(() => Math.random() - 0.5)
    const result = initSort(shuffled)
    if (result.kind === 'done') {
      setRanked(result.result)
      setPhase('results')
    } else {
      setSortState(result.state)
      setPhase('battle')
    }
  }, [inputText])

  const vote = useCallback(
    (choice: Choice) => {
      if (!sortState) return
      setHistory((prev) => [...prev, sortState])
      const result = step(sortState, choice)
      if (result.kind === 'done') {
        setRanked(result.result)
        setSortState(null)
        setPhase('results')
      } else {
        setSortState(result.state)
      }
    },
    [sortState],
  )

  const goBack = useCallback(() => {
    if (history.length === 0) return
    const prev = history[history.length - 1]
    setHistory((h) => h.slice(0, -1))
    setSortState(prev)
    setPhase('battle')
  }, [history])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (phase !== 'battle') return
      if (e.key === 'ArrowLeft') vote('left')
      else if (e.key === 'ArrowRight') vote('right')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, vote])

  const reset = useCallback(() => {
    setSortState(null)
    setRanked([])
    setHistory([])
    setPhase('input')
  }, [])

  const itemCount  = inputText.split('\n').filter((s) => s.trim()).length
  const done       = sortState?.done ?? 0
  const progress   = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0
  const comparison = sortState ? getComparison(sortState) : null
  const standings  = sortState
    ? [...sortState.battled].sort((a, b) => (sortState.elo.get(b) ?? BASE) - (sortState.elo.get(a) ?? BASE))
    : []

  // ── Input ─────────────────────────────────────────────────────────────────
  if (phase === 'input') {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <div className="w-full max-w-sm space-y-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">rankr</h1>
            <p className="text-sm text-muted-foreground mt-1">
              One item per line. Vote head-to-head to get your definitive ranking.
            </p>
          </div>
          <Textarea
            placeholder={'Apples\nOranges\nBananas\nMangoes\nGrapes'}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            className="min-h-48 font-mono text-sm resize-none"
          />
          <Button onClick={start} disabled={itemCount < 2} className="w-full">
            Start ranking {itemCount >= 2 ? `(~${maxComparisons(itemCount)} battles)` : ''}
          </Button>
        </div>
      <p className="fixed bottom-4 right-4 text-xs text-muted-foreground/50">
        by <a href="https://github.com/mshik3" target="_blank" rel="noopener noreferrer" className="hover:text-muted-foreground transition-colors">mshik3</a>
      </p>
      </div>
    )
  }

  // ── Battle ────────────────────────────────────────────────────────────────
  if (phase === 'battle' && comparison) {
    return (
      <div className="h-screen flex overflow-hidden">
        {/* Main battle area */}
        <div className="flex-1 flex flex-col items-center justify-center gap-8 p-8 min-w-0 overflow-hidden">
          <div className="w-full max-w-2xl space-y-2">
            <div className="flex items-center justify-between">
              <Button
                variant="ghost"
                size="sm"
                onClick={goBack}
                disabled={history.length === 0}
                className="h-6 px-2 text-xs text-muted-foreground disabled:opacity-30"
              >
                ← back
              </Button>
              <span className="text-xs text-muted-foreground">
                {done} / {total}
              </span>
            </div>
            <Progress value={progress} className="h-1" />
          </div>

          <div className="w-full max-w-2xl grid grid-cols-2 gap-4">
            <Card
              className="cursor-pointer hover:border-foreground transition-colors select-none"
              onClick={() => vote('left')}
            >
              <CardContent className="flex items-center justify-center min-h-44 p-8">
                <span className="text-2xl font-medium text-center leading-snug">
                  {comparison.left}
                </span>
              </CardContent>
            </Card>

            <Card
              className="cursor-pointer hover:border-foreground transition-colors select-none"
              onClick={() => vote('right')}
            >
              <CardContent className="flex items-center justify-center min-h-44 p-8">
                <span className="text-2xl font-medium text-center leading-snug">
                  {comparison.right}
                </span>
              </CardContent>
            </Card>
          </div>

          <p className="text-xs text-muted-foreground">← → arrow keys or click</p>
        </div>

        {/* Live standings sidebar */}
        <div className="w-44 border-l shrink-0 p-4 flex flex-col gap-3 overflow-y-auto">
          <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Standings
          </p>
          {standings.length === 0 ? (
            <p className="text-xs text-muted-foreground">First battle incoming…</p>
          ) : (
            <div className="space-y-1.5">
              {standings.map((item, i) => {
                const active = item === comparison.left || item === comparison.right
                return (
                  <div key={item} className="flex items-center gap-2 min-w-0">
                    <span className="text-xs text-muted-foreground tabular-nums w-4 text-right shrink-0">
                      {i + 1}
                    </span>
                    <span className={`text-sm truncate flex-1 ${active ? 'font-semibold' : 'text-muted-foreground'}`}>
                      {item}
                    </span>
                    <span className="text-xs tabular-nums shrink-0 text-muted-foreground">
                      {Math.round(sortState!.elo.get(item) ?? BASE)}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── Results ───────────────────────────────────────────────────────────────
  const downloadRanking = () => {
    const text = ranked.map((item, i) => `${String(i + 1).padStart(2)}. ${item}`).join('\n')
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'ranking.txt'
    a.click()
    URL.revokeObjectURL(url)
  }

  if (phase === 'results') {
    return (
      <div className="min-h-screen flex items-center justify-center p-8">
        <div className="w-full max-w-sm space-y-4">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-semibold tracking-tight">Your ranking</h1>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={downloadRanking}>
                Export
              </Button>
              <Button variant="outline" size="sm" onClick={reset}>
                Start over
              </Button>
            </div>
          </div>
          <div>
            {ranked.map((item, i) => (
              <div key={i} className="flex items-center gap-3 py-2.5 border-b last:border-0">
                <span className="text-sm text-muted-foreground tabular-nums w-5 text-right shrink-0">
                  {i + 1}
                </span>
                <span className="font-medium">{item}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return null
}

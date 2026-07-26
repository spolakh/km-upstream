// @vitest-environment happy-dom
/**
 * The reveal-playback pin for the layout-session host's Activity policy
 * (LayoutSessionHost) — a unit-level spike of the headline behavior:
 * a playing video in a warm-but-hidden session must NOT be paused when
 * its session is hidden or revealed.
 *
 * The mechanism under test is the composition of three parts:
 *   1. `<Activity mode="hidden">` PRESERVES component state (the
 *      `isPlaying` flag VideoPlayerRenderer keeps synced to native
 *      playback via onPlay/onPause) while destroying effects;
 *   2. on reveal, effects re-mount and react-player's enforcement
 *      effect re-runs against the preserved `playing` prop — with
 *      `playing === true` still matching actual playback, the
 *      enforcement is a NO-OP (no pause command);
 *   3. the DOM (and thus the media element) is preserved across the
 *      hide/reveal cycle, so playback state has nowhere to get lost.
 *
 * HONESTY BOUNDARY: this harness fakes react-player with the smallest
 * model of its controlled-`playing` enforcement (align native playback
 * with the prop on every effect run) and fakes native playback as a
 * plain object standing in for the media element. What it PINS is that
 * the prop channel never commands a pause across the hide/reveal cycle
 * and that `isPlaying` survives it. What it CANNOT express in
 * happy-dom: whether the real react-player registers effect CLEANUPS
 * that pause/destroy the native player (Activity runs cleanups on
 * hide), and whether a real display:none'd <video> keeps its audio
 * running. Those halves need a real-browser check when the opt-in
 * lands. The control case at the bottom proves the harness CAN detect
 * the failure it guards against (state loss → enforcement pause).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Activity, useEffect, useState } from 'react'
import { act, cleanup, render } from '@testing-library/react'

afterEach(() => cleanup())

/** Harness state living OUTSIDE React — `media` stands in for the native
 *  media element (a preserved DOM node under Activity: playback state
 *  survives any React-side hide/reveal), `commands`/`renderedPlaying`
 *  record what the prop channel did to it. Module-scoped (reset per test)
 *  rather than a prop so the harness components never mutate props. */
const harness = {
  media: {paused: true},
  commands: [] as string[],
  renderedPlaying: [] as boolean[],
  nativePlay: null as (() => void) | null,
}

const resetHarness = (): void => {
  harness.media = {paused: true}
  harness.commands = []
  harness.renderedPlaying = []
  harness.nativePlay = null
}

/** Minimal model of react-player's controlled-`playing` contract: on every
 *  effect run, align native playback with the prop (VideoPlayerRenderer's
 *  comment: "Keep the controlled `playing` prop truthful to native playback
 *  so react-player's enforcement effect is a no-op on re-run"). */
function FakeReactPlayer({playing, onPlay}: {playing: boolean; onPlay: () => void}) {
  harness.renderedPlaying.push(playing)
  useEffect(() => {
    // Expose the native-play trigger (the user clicking the media's own
    // controls) so the test can start playback the way the real renderer
    // observes it: native event first, prop-sync callback second.
    harness.nativePlay = () => {
      harness.media.paused = false
      onPlay()
    }
    if (playing && harness.media.paused) {
      harness.media.paused = false
      harness.commands.push('play')
    }
    if (!playing && !harness.media.paused) {
      harness.media.paused = true
      harness.commands.push('pause')
    }
  })
  return <div data-testid="player" data-playing={playing}/>
}

/** The video-player-like child: `playing` state synced to native playback
 *  via onPlay/onPause, exactly the VideoPlayerRenderer pattern. */
function PlayerHarness() {
  const [isPlaying, setIsPlaying] = useState(false)
  return (
    <FakeReactPlayer
      playing={isPlaying}
      onPlay={() => setIsPlaying(true)}
    />
  )
}

const Sessions = ({active}: {active: 'a' | 'b'}) => (
  <>
    <Activity mode={active === 'a' ? 'visible' : 'hidden'}>
      <div data-session="a">
        <PlayerHarness/>
      </div>
    </Activity>
    <Activity mode={active === 'b' ? 'visible' : 'hidden'}>
      <div data-session="b"/>
    </Activity>
  </>
)

describe('Activity hide/reveal never commands a pause on a playing video', () => {
  it('preserves isPlaying across the cycle and the reveal enforcement is a no-op', async () => {
    resetHarness()
    const view = render(<Sessions active="a"/>)

    // User starts playback via the native controls: media plays, onPlay
    // syncs the controlled prop to true. Enforcement then has nothing to do.
    await act(async () => harness.nativePlay?.())
    expect(harness.media.paused).toBe(false)
    expect(harness.commands).toEqual([])
    expect(view.getByTestId('player').dataset.playing).toBe('true')

    // Switch away: session A hides. State is preserved, DOM is preserved
    // (the player element is still there, just hidden), and — the pin —
    // nothing commanded a pause through the prop channel.
    await act(async () => view.rerender(<Sessions active="b"/>))
    expect(view.getByTestId('player')).toBeTruthy() // DOM preserved, not unmounted
    expect(harness.media.paused).toBe(false)
    expect(harness.commands).toEqual([])

    // Switch back: session A reveals, effects re-mount, the enforcement
    // effect re-runs against the PRESERVED playing=true — a no-op.
    await act(async () => view.rerender(<Sessions active="a"/>))
    expect(view.getByTestId('player').dataset.playing).toBe('true')
    expect(harness.media.paused).toBe(false)
    expect(harness.commands).toEqual([])
    // The prop channel never showed the player a pause at any render AFTER
    // playback started (the initial not-yet-playing renders are legitimately
    // false — only the post-play window carries the pin).
    const firstPlayingIndex = harness.renderedPlaying.indexOf(true)
    expect(firstPlayingIndex).toBeGreaterThanOrEqual(0)
    expect(harness.renderedPlaying.slice(firstPlayingIndex)).not.toContain(false)
  })

  it('control: WITHOUT Activity (unmount/remount) the same harness detects the pause', async () => {
    resetHarness()
    const view = render(<PlayerHarness/>)
    await act(async () => harness.nativePlay?.())
    expect(harness.media.paused).toBe(false)

    // Unmount (what session switching did before the host): React state is
    // LOST. Remount renders playing=false while the media still plays —
    // the enforcement effect commands the pause the Activity path must never
    // produce. This is the falsifiability check for the pin above.
    view.unmount()
    render(<PlayerHarness/>)
    expect(harness.commands).toContain('pause')
    expect(harness.media.paused).toBe(true)
  })
})

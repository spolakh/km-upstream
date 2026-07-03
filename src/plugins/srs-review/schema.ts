import { ChangeScope, codecs, defineBlockType, defineProperty, INFRASTRUCTURE_TYPE_DISPLAY } from '@/data/api'

export const SRS_REVIEW_DECK_TYPE = 'srs-review-deck'

/** The tag a deck reviews, stored as the bare page name (matching
 *  `blockTagsConfigProp`). Resolved to a block id at query time via
 *  `core.aliasLookup`. Empty string is the "all due" deck — every SRS
 *  card due today or earlier, regardless of tag. */
export const reviewDeckTagProp = defineProperty<string>('srs-review:deck-tag', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

/** False until the user picks a deck in the in-place picker; flips the
 *  deck renderer from the picker to the review session. A persisted
 *  flag (rather than React state) so reopening the deck block resumes
 *  the chosen deck instead of dropping back to the picker. The session
 *  writes it back to false via its "Change deck" affordance. */
export const reviewDeckStartedProp = defineProperty<boolean>('srs-review:deck-started', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.BlockDefault,
})

export const srsReviewDeckType = defineBlockType({
  id: SRS_REVIEW_DECK_TYPE,
  label: 'SRS review deck',
  properties: [reviewDeckTagProp, reviewDeckStartedProp],
})

export const SRS_REVIEW_PROGRESS_TYPE = 'srs-review-progress'

/** A frozen review session's persisted state. Stored on a per-deck child
 *  of the plugin's ui-state block (see `usePluginUIStateChildBlock`, keyed
 *  by deck id) so each deck keeps its own session across navigating away
 *  and back — both the user's place (`index`/`revealed`) and the frozen
 *  card order (`queue`), so returning doesn't re-run the due-cards query or
 *  restart at card one. `tag` and `day` still scope the saved state:
 *  retagging the deck, or a midnight rollover, invalidates it so the queue
 *  rebuilds from the live due set instead of resuming a stale one. */
export interface ReviewProgress {
  queue: string[]
  index: number
  revealed: boolean
  tag: string
  day: string
}

/** Single object property (one write per state change) rather than five
 *  scalar props. `ChangeScope.UiState` routes it into the ui-state
 *  subtree, undo-segregated from document edits — it's session/UI state,
 *  not document content. */
export const reviewProgressProp = defineProperty<ReviewProgress | null>('srs-review:progress', {
  codec: codecs.unsafeIdentity<ReviewProgress | null>(),
  defaultValue: null,
  changeScope: ChangeScope.UiState,
})

export const srsReviewProgressType = defineBlockType({
  id: SRS_REVIEW_PROGRESS_TYPE,
  label: 'SRS review progress',
  ...INFRASTRUCTURE_TYPE_DISPLAY,
  properties: [reviewProgressProp],
})

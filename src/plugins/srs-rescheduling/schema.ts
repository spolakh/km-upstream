import { ChangeScope, codecs, defineBlockType, defineProperty, INFRASTRUCTURE_TYPE_DISPLAY } from '@/data/api'
// Sub-path import (not the barrel) — `schema.ts` is loaded from
// `srsReschedulingDataExtension`, which is in the static-data graph.
// Importing the barrel would force daily-notes/index.ts to evaluate
// before React boots, dragging `@/extensions/blockInteraction` and
// closing a load-time cycle through globalState → repoProvider.
import { DAILY_NOTE_TYPE } from '@/plugins/daily-notes/schema.js'

export const SRS_SM25_TYPE = 'srs-sm2.5'

export interface SrsReviewSnapshot {
  reviewedAt: string
  grade: number
  interval: number
  factor: number
  reviewCount: number
}

export const srsIntervalProp = defineProperty<number>('interval', {
  codec: codecs.number,
  defaultValue: 2,
  changeScope: ChangeScope.BlockDefault,
})

export const srsFactorProp = defineProperty<number>('factor', {
  codec: codecs.number,
  defaultValue: 2.5,
  changeScope: ChangeScope.BlockDefault,
})

export const srsNextReviewDateProp = defineProperty<string>('next-review-date', {
  codec: codecs.ref({targetTypes: [DAILY_NOTE_TYPE]}),
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

export const srsReviewCountProp = defineProperty<number>('review-count', {
  codec: codecs.number,
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})

export const srsGradeProp = defineProperty<number>('grade', {
  codec: codecs.number,
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})

export const srsArchivedProp = defineProperty<boolean>('archived', {
  codec: codecs.boolean,
  defaultValue: false,
  changeScope: ChangeScope.BlockDefault,
})

export const srsSnapshotHistoryProp = defineProperty<SrsReviewSnapshot[]>('snapshot-history', {
  codec: codecs.list(codecs.unsafeIdentity<SrsReviewSnapshot>()),
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

export const srsSm25Type = defineBlockType({
  id: SRS_SM25_TYPE,
  label: 'SRS SM-2.5',
  ...INFRASTRUCTURE_TYPE_DISPLAY,
  properties: [
    srsIntervalProp,
    srsFactorProp,
    srsNextReviewDateProp,
    srsReviewCountProp,
    srsGradeProp,
    srsArchivedProp,
    srsSnapshotHistoryProp,
  ],
})

import {
  ChangeScope,
  codecs,
  defineBlockType,
  defineProperty,
} from '@/data/api'

export const TODO_TYPE = 'todo'

export type TodoStatus = 'open' | 'done'
export type RoamTodoState = 'TODO' | 'DONE'

export const statusProp = defineProperty<TodoStatus>('status', {
  // `codecs.enum` infers the literal union and renders as a select in the
  // property panel; values are constrained to the set on write.
  codec: codecs.enum(['open', 'done']),
  defaultValue: 'open',
  changeScope: ChangeScope.BlockDefault,
})

export const roamTodoStateProp = defineProperty<RoamTodoState>('roam:todo-state', {
  codec: codecs.enum(['TODO', 'DONE']),
  defaultValue: 'TODO',
  changeScope: ChangeScope.BlockDefault,
})

export const todoType = defineBlockType({
  id: TODO_TYPE,
  label: 'Todo',
  // The checkbox renderer already conveys todo-ness on every todo
  // block — a trailing #Todo tag chip would be pure duplication. Still
  // taggable via # and fully visible in the property panel.
  hideFromBlockDisplay: true,
  properties: [statusProp],
})

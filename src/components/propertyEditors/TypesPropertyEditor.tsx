import { useId, useMemo, useState, type KeyboardEvent } from 'react'
import { Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { type PropertyEditorProps } from '@/data/api'
import { typesFacet } from '@/data/facets.js'
import { Block } from '@/data/block'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { FloatingListbox } from '@/components/ui/floating-listbox.js'

interface TypeOption {
  id: string
  label: string
  description?: string
  structural: boolean
}

const normalizedTypes = (value: readonly string[]): readonly string[] =>
  Array.from(new Set(value.map(type => type.trim()).filter(Boolean)))

/** A user-defined type's id is the type-definition block's uuid —
 *  meaningless to a human picking the type. Hide it from the dropdown
 *  so a long uuid can't visually drown the label even in narrow panels;
 *  kernel ids ("page", "block-type", etc.) are short and human-readable
 *  and stay visible as disambiguation alongside their label. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isOpaqueId = (id: string): boolean => UUID_PATTERN.test(id)

export function TypesPropertyEditor({
  value,
  block,
}: PropertyEditorProps<readonly string[]>) {
  const runtime = useAppRuntime()
  const listboxId = useId()
  const [shellElement, setShellElement] = useState<HTMLDivElement | null>(null)
  const typedBlock = block instanceof Block ? block : null
  const readOnly = typedBlock?.repo.isReadOnly ?? true
  const selected = useMemo(() => normalizedTypes(value), [value])
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const typesRegistry = runtime.read(typesFacet)
  const options = useMemo<TypeOption[]>(() => Array.from(typesRegistry.values()).map(type => ({
    id: type.id,
    label: type.label ?? type.id,
    description: type.description,
    structural: type.structural === true,
  })), [typesRegistry])
  const optionsById = useMemo(() => new Map(options.map(option => [option.id, option])), [options])
  const queryText = query.trim().toLowerCase()
  const filtered = useMemo(() => options.filter(option => {
    if (selectedSet.has(option.id)) return false
    if (!queryText) return true
    return option.id.toLowerCase().includes(queryText) ||
      option.label.toLowerCase().includes(queryText)
  }), [options, queryText, selectedSet])

  const setTypes = (nextTypes: readonly string[]) => {
    if (!typedBlock || readOnly) return
    void typedBlock.repo.setBlockTypes(typedBlock.id, normalizedTypes(nextTypes))
  }

  const addType = (typeId: string) => {
    if (!typesRegistry.has(typeId) || selectedSet.has(typeId)) return
    setTypes([...selected, typeId])
    setQuery('')
    setOpen(false)
  }

  const removeType = (typeId: string) => {
    setTypes(selected.filter(selectedType => selectedType !== typeId))
  }

  const commitCurrentQuery = (): boolean => {
    // A user-defined type can share a label with a structural kernel/
    // plugin type ("page", "Media"). Typing that label into a TYPE
    // picker almost always means the taggable one — preferring it
    // matches the `#` autocomplete's resolution (the ref-target picker
    // currently resolves such collisions by registration order — a
    // known gap, not a policy to be consistent with).
    const exactMatches = options.filter(option =>
      option.id.toLowerCase() === queryText ||
      option.label.toLowerCase() === queryText)
    const exact = exactMatches.find(option => !option.structural) ?? exactMatches[0]
    // An explicit arrow-key selection beats the exact-match shortcut —
    // committing something other than the highlighted row contradicts
    // what the user is looking at.
    const option = activeIndex > 0
      ? filtered[activeIndex] ?? filtered[0]
      : exact && !selectedSet.has(exact.id)
        ? exact
        : filtered[activeIndex] ?? filtered[0]
    if (!option) return false
    addType(option.id)
    return true
  }

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (readOnly) return

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setActiveIndex(index => Math.min(index + 1, Math.max(filtered.length - 1, 0)))
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(index => Math.max(index - 1, 0))
      return
    }

    if ((event.key === 'Enter' || event.key === 'Tab') && query.trim()) {
      if (commitCurrentQuery()) event.preventDefault()
      return
    }

    if (event.key === 'Backspace' && !query && selected.length > 0) {
      event.preventDefault()
      removeType(selected[selected.length - 1])
      return
    }

    if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  return (
    <div
      className="min-w-0"
      onBlur={() => {
        window.setTimeout(() => setOpen(false), 120)
      }}
    >
      <div
        ref={setShellElement}
        className="flex min-h-7 min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-transparent bg-transparent px-0 py-0.5 focus-within:border-input focus-within:px-1.5"
      >
        {selected.map(typeId => {
          const option = optionsById.get(typeId)
          const label = option?.label ?? typeId
          return (
            <span
              key={typeId}
              className="inline-flex max-w-full items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs text-foreground"
              title={option?.description ?? typeId}
            >
              <span className="truncate">{label}</span>
              {!readOnly && (
                <button
                  type="button"
                  className="rounded-sm text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  aria-label={`Remove ${label} type`}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => removeType(typeId)}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </span>
          )
        })}
        <input
          className="h-6 min-w-[8rem] flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/55 disabled:cursor-not-allowed disabled:opacity-60"
          value={query}
          placeholder="Add type"
          disabled={readOnly}
          role="combobox"
          aria-label="Add block type"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          onFocus={() => setOpen(true)}
          onChange={event => {
            setQuery(event.target.value)
            setActiveIndex(0)
            setOpen(true)
          }}
          onKeyDown={handleInputKeyDown}
        />
      </div>

      <FloatingListbox
        id={listboxId}
        open={open && !readOnly}
        anchorElement={shellElement}
        maxWidth={352}
        maxHeight={224}
      >
        {filtered.length > 0 ? filtered.map((option, index) => (
          <button
            key={option.id}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={cn(
              'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left',
              index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-accent hover:text-accent-foreground',
            )}
            onMouseDown={event => event.preventDefault()}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => addType(option.id)}
          >
            <Plus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.label !== option.id && !isOpaqueId(option.id) && (
              // Auxiliary id badge — shown only for human-readable ids
              // (kernel: "page", "block-type", "panel:properties"). User-
              // defined types have uuid ids that carry no signal to the
              // picker; hiding them keeps the label fully visible even
              // in narrow panel widths.
              <span className="min-w-0 max-w-[12rem] truncate text-xs text-muted-foreground">{option.id}</span>
            )}
          </button>
        )) : (
          <div className="px-2 py-1.5 text-muted-foreground">No matching types</div>
        )}
      </FloatingListbox>
    </div>
  )
}

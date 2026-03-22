import { Database } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { Button } from '@/app/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/app/components/ui/dropdown-menu'
import {
  AlbumsSearchParams,
  SongSourceFilter,
  SourceFilter,
  SourceFilters,
  sourceFilterValues,
} from '@/utils/albumsFilter'
import { SearchParamsHandler } from '@/utils/searchParamsHandler'

interface SourceFilterOption {
  key: string
  label: string
}

type AnySourceFilter = SourceFilter | SongSourceFilter

interface SourceFilterComponentProps {
  options?: SourceFilterOption[]
  defaultFilter?: AnySourceFilter
}

export function SourceFilterComponent({
  options = sourceFilterValues,
  defaultFilter = SourceFilters.All,
}: SourceFilterComponentProps = {}) {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const { getSearchParam } = new SearchParamsHandler(searchParams)

  const currentFilter = getSearchParam<AnySourceFilter>(
    AlbumsSearchParams.Source,
    defaultFilter,
  )

  const currentFilterLabel = options.find(
    (item) => item.key === currentFilter,
  )?.label

  function handleChangeFilter(filter: AnySourceFilter) {
    setSearchParams((state) => {
      state.set(AlbumsSearchParams.Source, filter)
      return state
    })
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Database className="w-4 h-4 mr-2" />
          {t(currentFilterLabel || options[0]?.label || 'source.filter.all')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map((item, index) => (
          <DropdownMenuCheckboxItem
            key={index}
            checked={item.key === currentFilter}
            onCheckedChange={() => handleChangeFilter(item.key as AnySourceFilter)}
            className="cursor-pointer"
          >
            {t(item.label)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

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
  SourceFilter,
  SourceFilters,
  sourceFilterValues,
} from '@/utils/albumsFilter'
import { SearchParamsHandler } from '@/utils/searchParamsHandler'

export function SourceFilterComponent() {
  const { t } = useTranslation()
  const [searchParams, setSearchParams] = useSearchParams()
  const { getSearchParam } = new SearchParamsHandler(searchParams)

  const currentFilter = getSearchParam<SourceFilter>(
    AlbumsSearchParams.Source,
    SourceFilters.All,
  )

  const currentFilterLabel = sourceFilterValues.find(
    (item) => item.key === currentFilter,
  )?.label

  function handleChangeFilter(filter: SourceFilter) {
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
          {t(currentFilterLabel || 'source.filter.all')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {sourceFilterValues.map((item, index) => (
          <DropdownMenuCheckboxItem
            key={index}
            checked={item.key === currentFilter}
            onCheckedChange={() => handleChangeFilter(item.key as SourceFilter)}
            className="cursor-pointer"
          >
            {t(item.label)}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

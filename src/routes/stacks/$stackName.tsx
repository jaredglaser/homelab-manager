import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import StackEditorForm from '@/components/stacks/StackEditorForm'
import { getStackDetail } from '@/data/stacks/functions'
import { Spinner } from '@/components/ui/spinner';

export const Route = createFileRoute('/stacks/$stackName')({
  ssr: false,
  component: StackEditorView,
})

function StackEditorView() {
  const { stackName } = Route.useParams()

  const { data: detail, isLoading, error } = useQuery({
    queryKey: ['stack-detail', stackName],
    queryFn: () => getStackDetail({ data: { stackName } }),
  })

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm opacity-70 py-8">
        <Spinner className="size-4" />
        <span>Loading {stackName}...</span>
      </div>
    )
  }

  if (error || !detail) {
    return (
      <p className="text-sm opacity-70 py-8">
        {error ? `Failed to load: ${error.message}` : 'Stack not found in repository.'}
      </p>
    )
  }

  // Keyed by stackName so switching stacks mounts a fresh form (clean draft +
  // dirty baselines) instead of carrying the previous stack's edits over.
  return <StackEditorForm key={stackName} stackName={stackName} detail={detail} />
}

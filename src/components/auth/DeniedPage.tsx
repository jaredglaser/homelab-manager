export default function DeniedPage() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-[var(--mui-palette-background-default)]">
      <div className="flex flex-col items-center gap-4 p-8 rounded-xl bg-[var(--mui-palette-background-paper)] shadow-lg w-full max-w-md text-center">
        <h1 className="text-2xl font-semibold text-[var(--mui-palette-text-primary)]">
          You don&apos;t have access to this application
        </h1>
        <p className="text-[var(--mui-palette-text-secondary)]">
          Your account is not assigned to any recognized role in your OIDC provider
        </p>
        <p className="text-[var(--mui-palette-text-secondary)]">
          Please contact your administrator to be added to the appropriate group
        </p>
      </div>
    </div>
  )
}

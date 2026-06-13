export default function DeniedPage() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-[var(--background)]">
      <div className="flex flex-col items-center gap-4 p-8 rounded-xl bg-[var(--card)] shadow-lg w-full max-w-md text-center">
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">
          You don&apos;t have access to this application
        </h1>
        <p className="text-[var(--muted-foreground)]">
          Your account is not assigned to any recognized role in your OIDC provider
        </p>
        <p className="text-[var(--muted-foreground)]">
          Please contact your administrator to be added to the appropriate group
        </p>
      </div>
    </div>
  )
}

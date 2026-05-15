interface Props {
  prompt?: string;
}

export default function LoginPage({ prompt }: Props) {
  const loginHref = prompt ? `/api/auth/login?prompt=${encodeURIComponent(prompt)}` : '/api/auth/login';

  return (
    <div className="flex items-center justify-center min-h-screen bg-[var(--mui-palette-background-default)]">
      <div className="flex flex-col items-center gap-6 p-8 rounded-xl bg-[var(--mui-palette-background-paper)] shadow-lg w-full max-w-sm">
        <h1 className="text-2xl font-semibold text-[var(--mui-palette-text-primary)]">
          Homelab Manager
        </h1>
        <a
          href={loginHref}
          className="w-full text-center py-2 px-4 rounded-md bg-[var(--mui-palette-primary-main)] text-[var(--mui-palette-primary-contrastText)] font-medium hover:bg-[var(--mui-palette-primary-dark)] transition-colors"
        >
          Sign in
        </a>
      </div>
    </div>
  )
}

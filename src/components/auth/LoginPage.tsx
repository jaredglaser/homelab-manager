interface Props {
  prompt?: string;
}

export default function LoginPage({ prompt }: Props) {
  const loginHref = prompt ? `/api/auth/login?prompt=${encodeURIComponent(prompt)}` : '/api/auth/login';

  return (
    <div className="flex items-center justify-center min-h-screen bg-[var(--background)]">
      <div className="flex flex-col items-center gap-6 p-8 rounded-xl bg-[var(--card)] shadow-lg w-full max-w-sm">
        <h1 className="text-2xl font-semibold text-[var(--foreground)]">
          Homelab Manager
        </h1>
        <a
          href={loginHref}
          className="w-full text-center py-2 px-4 rounded-md bg-[var(--primary)] text-[var(--primary-foreground)] font-medium hover:bg-[var(--primary-dark)] transition-colors"
        >
          Sign in
        </a>
      </div>
    </div>
  )
}

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-[#0b0f1a] text-white px-6 py-16">
      <div className="max-w-3xl mx-auto space-y-8">
        <h1 className="text-4xl font-bold">Terms of Use</h1>

        <p>
          By using Seeker Streaks, you agree to these terms. This app is a
          competitive daily check-in experience for the Solana Seeker
          community.
        </p>

        <h2 className="text-2xl font-semibold">Usage</h2>
        <p>
          Users must connect a valid Solana wallet to participate. You are
          responsible for maintaining the security of your wallet.
        </p>

        <h2 className="text-2xl font-semibold">Streak System</h2>
        <p>
          Seeker Streaks tracks daily activity to maintain streaks and
          leaderboard rankings. Missing a check-in may result in streak loss
          unless protections are used.
        </p>

        <h2 className="text-2xl font-semibold">No Financial Advice</h2>
        <p>
          This application does not provide financial advice and does not
          custody user funds.
        </p>

        <h2 className="text-2xl font-semibold">Limitation of Liability</h2>
        <p>
          The app is provided "as is" without warranties of any kind.
        </p>

        <p className="text-sm opacity-70">
          © {new Date().getFullYear()} Seeker Streaks
        </p>
      </div>
    </main>
  );
}

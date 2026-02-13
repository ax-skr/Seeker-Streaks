export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[#0b0f1a] text-white px-6 py-16">
      <div className="max-w-3xl mx-auto space-y-8">
        <h1 className="text-4xl font-bold">Privacy Policy</h1>

        <p>
          Seeker Streaks respects your privacy. This policy explains what data
          we collect and how it is used.
        </p>

        <h2 className="text-2xl font-semibold">Wallet Information</h2>
        <p>
          We collect public wallet addresses to enable authentication,
          streak tracking, and leaderboard functionality. Private keys are
          never accessed or stored.
        </p>

        <h2 className="text-2xl font-semibold">Usage Data</h2>
        <p>
          Basic usage data may be collected to improve performance and user
          experience.
        </p>

        <h2 className="text-2xl font-semibold">Data Storage</h2>
        <p>
          Data is securely stored using backend services required to operate
          the application.
        </p>

        <h2 className="text-2xl font-semibold">Contact</h2>
        <p>
          For privacy inquiries, contact seekerstreaks@gmail.com.
        </p>

        <p className="text-sm opacity-70">
          © {new Date().getFullYear()} Seeker Streaks
        </p>
      </div>
    </main>
  );
}

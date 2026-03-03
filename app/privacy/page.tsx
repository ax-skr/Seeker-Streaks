export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-[#0b0f1a] text-white px-6 py-16">
      <div className="max-w-3xl mx-auto space-y-8">
        <h1 className="text-4xl font-bold">Privacy Policy</h1>

        <p>
          This Privacy Policy explains how Seeker Streaks ("Application")
          processes information. The Application is operated from
          England, United Kingdom.
        </p>

        <h2 className="text-2xl font-semibold">Data Collected</h2>
        <p>
          The Application collects public blockchain wallet addresses,
          check-in timestamps, streak data, leaderboard data, and limited
          technical usage information necessary for operation.
        </p>

        <h2 className="text-2xl font-semibold">Private Keys</h2>
        <p>
          The Application does not access, request, store, or control
          private keys.
        </p>

        <h2 className="text-2xl font-semibold">Purpose of Processing</h2>
        <p>
          Data is processed to provide authentication, streak tracking,
          leaderboard functionality, fraud prevention, and service
          stability.
        </p>

        <h2 className="text-2xl font-semibold">Legal Basis (UK GDPR)</h2>
        <p>
          Where applicable, data is processed under legitimate interest
          for the purpose of operating the Application in accordance
          with UK data protection laws.
        </p>

        <h2 className="text-2xl font-semibold">Third-Party Infrastructure</h2>
        <p>
          The Application relies on third-party infrastructure providers
          such as hosting platforms, database services, and blockchain
          RPC providers. These services may process limited technical
          data required for functionality.
        </p>

        <h2 className="text-2xl font-semibold">Data Retention</h2>
        <p>
          Wallet and streak data are retained as long as necessary to
          provide leaderboard and streak functionality unless deletion
          is legally required.
        </p>

        <h2 className="text-2xl font-semibold">Security</h2>
        <p>
          Reasonable technical measures are implemented to protect stored
          information. However, no system can guarantee absolute security.
        </p>

        <h2 className="text-2xl font-semibold">Your Rights</h2>
        <p>
          Depending on your jurisdiction, you may have rights regarding
          access or correction of certain personal data.
        </p>

        <h2 className="text-2xl font-semibold">Contact</h2>
        <p>
          For privacy inquiries, contact seekerstreaks@gmail.com.
        </p>

        <p className="text-sm opacity-70">
          © {new Date().getFullYear()} Seeker Streaks. All rights reserved.
        </p>
      </div>
    </main>
  );
}
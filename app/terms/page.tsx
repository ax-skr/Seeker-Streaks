export default function TermsPage() {
  return (
    <main className="min-h-screen bg-[#0b0f1a] text-white px-6 py-16">
      <div className="max-w-3xl mx-auto space-y-8">
        <h1 className="text-4xl font-bold">Terms of Use</h1>

        <p>
          These Terms of Use ("Terms") govern access to and use of the
          Seeker Streaks application ("Application"). By accessing or
          using the Application, you agree to be legally bound by these
          Terms. If you do not agree, you must not use the Application.
        </p>

        <h2 className="text-2xl font-semibold">Operator</h2>
        <p>
          Seeker Streaks is operated by an independent developer based
          in England, United Kingdom, under the developer identity
          "ax.skr" ("Operator").
        </p>

        <h2 className="text-2xl font-semibold">Eligibility</h2>
        <p>
          You must be at least 18 years old or the age of majority in
          your jurisdiction to use the Application.
        </p>

        <h2 className="text-2xl font-semibold">Service Description</h2>
        <p>
          Seeker Streaks provides a competitive daily check-in tracking
          system for compatible blockchain wallet addresses. The
          Application tracks streak continuity and leaderboard rankings.
          The Application does not provide financial rewards, yield,
          monetary incentives, or investment opportunities.
        </p>

        <h2 className="text-2xl font-semibold">Wallet Responsibility</h2>
        <p>
          Users must connect a compatible Solana wallet. The Operator
          does not access, store, or control private keys. You are solely
          responsible for wallet security, transaction approvals, and
          all on-chain activity initiated from your wallet.
        </p>

        <h2 className="text-2xl font-semibold">Paid Protections</h2>
        <p>
          The Application may offer optional digital protection features
          allowing users to preserve streak continuity after a missed
          check-in. Protection fees are payable in supported blockchain
          tokens (such as SKR).
        </p>

        <p>
          Protection payments constitute a digital service fee. All
          payments are voluntary, processed on-chain, and non-refundable.
          Funds are transferred to an application treasury wallet
          controlled by the Operator.
        </p>

        <p>
          The Application does not provide financial services, investment
          products, custody services, or guarantees of outcome. Token
          value volatility is outside the control of the Operator and is
          solely the responsibility of the user.
        </p>

        <h2 className="text-2xl font-semibold">Service Continuity and Termination</h2>
        <p>
          The Application is provided at the sole discretion of the
          Operator. The Operator reserves the right to modify, suspend,
          discontinue, or terminate the Application, or any feature of
          the Application, at any time without prior notice.
        </p>

        <p>
          There is no guarantee that Seeker Streaks will continue to
          operate indefinitely or beyond any particular phase, period,
          or development stage. The Application may be ended at the
          Operator’s sole discretion.
        </p>

        <p>
          In the event of suspension or termination of the Application,
          users acknowledge that no refunds, compensation, or continued
          functionality are guaranteed.
        </p>

        <h2 className="text-2xl font-semibold">No Financial Advice</h2>
        <p>
          Nothing within the Application constitutes financial,
          investment, legal, or tax advice.
        </p>

        <h2 className="text-2xl font-semibold">Assumption of Risk</h2>
        <p>
          Blockchain technology carries inherent technical and economic
          risks, including network failures, smart contract errors,
          wallet malfunctions, backend outages, and asset volatility.
          You assume all risks associated with use of the Application.
        </p>

        <h2 className="text-2xl font-semibold">Prohibited Conduct</h2>
        <p>
          Users may not exploit bugs, manipulate timestamps, automate
          check-ins, interfere with backend systems, reverse engineer the
          Application, or attempt to unfairly influence leaderboard
          rankings. Violations may result in suspension, restriction,
          or permanent removal of access.
        </p>

        <h2 className="text-2xl font-semibold">Service Availability</h2>
        <p>
          The Application is provided on an "as is" and "as available"
          basis. The Operator does not guarantee uninterrupted,
          error-free, secure, or permanent operation.
        </p>

        <h2 className="text-2xl font-semibold">Limitation of Liability</h2>
        <p>
          To the maximum extent permitted by law, the Operator shall not
          be liable for indirect, incidental, consequential, special, or
          punitive damages arising from or related to use of the
          Application.
        </p>

        <h2 className="text-2xl font-semibold">No Partnership</h2>
        <p>
          Nothing in these Terms shall be construed as creating a
          partnership, joint venture, agency, fiduciary relationship,
          or employment relationship between the user and the Operator.
        </p>

        <h2 className="text-2xl font-semibold">Changes to These Terms</h2>
        <p>
          The Operator reserves the right to update, modify, or replace
          these Terms at any time. Updated Terms will be made publicly
          available. Continued use of the Application following any such
          updates constitutes acceptance of the revised Terms.
        </p>

        <h2 className="text-2xl font-semibold">Governing Law</h2>
        <p>
          These Terms are governed by the laws of England and Wales.
          Any disputes shall be subject to the exclusive jurisdiction of
          the courts of England and Wales.
        </p>

        <p className="text-sm opacity-70">
          © {new Date().getFullYear()} Seeker Streaks. All rights reserved.
        </p>
      </div>
    </main>
  );
}
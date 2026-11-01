import { useSeo } from "../hooks/useSeo";

export default function PrivacyPage() {
  useSeo("Privacy Policy", "How Nazar Restaurant & Bakery handles website, customer and connected reporting data.", "/privacy");
  return (
    <article className="mx-auto max-w-3xl space-y-7 px-4 py-10 text-sm leading-7 text-zinc-700">
      <header>
        <h1 className="text-3xl font-bold text-zinc-900">Privacy Policy</h1>
        <p>Last updated: October 31, 2026</p>
      </header>
      <section aria-labelledby="privacy-who">
        <h2 id="privacy-who" className="text-xl font-semibold text-zinc-900">Who this covers</h2>
        <p>This policy covers Nazar Restaurant &amp; Bakery’s website and its connected reporting tools. Nazar handles restaurant customer requests. Platform Ops Restaurants is the Google reporting application’s name; it is not the restaurant’s name.</p>
      </section>
      <section aria-labelledby="privacy-collect">
        <h2 id="privacy-collect" className="text-xl font-semibold text-zinc-900">Information we use</h2>
        <p>We use the contact details, preferences and catering information you submit, consent records, coupon activity and relevant order history. Website analytics and security services may receive device, cookie, IP address and usage information. QR and campaign tags help us understand how visitors reach the site.</p>
      </section>
      <section aria-labelledby="privacy-purpose">
        <h2 id="privacy-purpose" className="text-xl font-semibold text-zinc-900">Why we use it</h2>
        <p>We use this information to answer requests, provide offers you choose to receive, check coupon use, support orders, protect the service and measure performance. Marketing email requires your agreement; you can unsubscribe through the email or contact us. Ordering and payment providers handle checkout under their own privacy policies.</p>
      </section>
      <section aria-labelledby="privacy-api">
        <h2 id="privacy-api" className="text-xl font-semibold text-zinc-900">Connected Google and Meta accounts</h2>
        <p>When an authorized account owner connects an account, our reporting tools read account identifiers and aggregate performance data: Google Analytics sessions, Google Ads spend, impressions, clicks and conversions, and, if connected, Meta advertising spend, reach, impressions, clicks and results. These connections support business reporting, not publishing ads or changing campaigns. Google review reporting reads the public rating and review count, not review text.</p>
        <p>We do not sell API data, share it with data brokers, use it to build advertising audiences or train AI models. Human access is limited to authorized reporting users and necessary support with permission, security investigations or legal obligations. The application’s use and transfer of information received from Google APIs follows the <a className="underline" href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including its Limited Use requirements.</p>
      </section>
      <section aria-labelledby="privacy-sharing">
        <h2 id="privacy-sharing" className="text-xl font-semibold text-zinc-900">Sharing and protection</h2>
        <p>Authorized restaurant staff use information for the purposes above. Hosting, database, email, security, analytics and ordering providers process information needed to deliver their services. We may disclose information when required by law or to protect people and systems. We restrict access and keep connection credentials on the server, separate from public pages.</p>
      </section>
      <section aria-labelledby="privacy-opt-out">
        <h2 id="privacy-opt-out" className="text-xl font-semibold text-zinc-900">Your right to opt out of sale or sharing</h2>
        <p>Our website uses Google Analytics and Google Ads measurement through Google Tag Manager. You can opt out of the sale or sharing of your personal information for advertising at any time: use the “Do not sell or share my personal information” link at the bottom of every page. Your choice is saved on this device, and you can undo it from the same place. We also honor Global Privacy Control: if your browser sends this signal, advertising storage and advertising data sharing are turned off automatically. Opting out does not affect ordering, catering requests or VIP sign-up.</p>
      </section>
      <section aria-labelledby="privacy-retention">
        <h2 id="privacy-retention" className="text-xl font-semibold text-zinc-900">Keeping information and your choices</h2>
        <p>We keep information only as needed for the service, consent records, security and legal obligations, then delete or anonymize it. You can manage cookies in your browser and ask to access, correct or delete your information. Some records may need to be retained for legal or security reasons; we will explain any limits.</p>
      </section>
      <section aria-labelledby="data-deletion">
        <h2 id="data-deletion" className="text-xl font-semibold text-zinc-900">Disconnect an account or request deletion</h2>
        <p>Email <a className="break-all underline" href="mailto:ctnazarbakery@gmail.com">ctnazarbakery@gmail.com</a> with the subject “Privacy request.” Tell us whether your request concerns a website record or a connected Google/Meta account, and identify the account or business involved. Do not send passwords or tokens. We will verify your authority, arrange disconnection and delete associated data unless retention is required by law or security obligations.</p>
        <p>You can also revoke Google access in <a className="underline" href="https://myaccount.google.com/connections">your Google Account connections</a>. A Meta business administrator can revoke the integration’s token or asset access in Meta Business Settings. Revoking access stops future authorized collection; contact us to request deletion of stored data too.</p>
      </section>
      <section aria-labelledby="privacy-contact">
        <h2 id="privacy-contact" className="text-xl font-semibold text-zinc-900">Contact and changes</h2>
        <p>Contact Nazar Restaurant &amp; Bakery at the email above or 39 Elm Street, Unit 1, West Haven, CT. We post policy changes here and seek any additional consent required before using connected-account data for a new purpose.</p>
      </section>
    </article>
  );
}

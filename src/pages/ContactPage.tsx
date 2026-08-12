// src/pages/ContactPage.tsx
import { useMemo, useState } from "react";
import {
  BUSINESS_NAME,
  CLOVER_PICKUP_URL,
  PHONE_NUMBER_DISPLAY,
  PHONE_NUMBER_TEL,
} from "../data/menu";

type HoursRow = { day: string; hours: string };

export default function ContactPage() {
  // ✅ Edit these if needed
  const addressLine1 = "39 Elm Street, Unit 1";
  const cityStateZip = "West Haven, CT";
  const emailTo = "nazarrestaurantandbakery@gmail.com";

  // ✅ Hours (your latest)
  const hours: HoursRow[] = [
    { day: "Monday", hours: "9:00 AM – 9:00 PM" },
    { day: "Tuesday", hours: "9:00 AM – 9:00 PM" },
    { day: "Wednesday", hours: "Closed" },
    { day: "Thursday", hours: "9:00 AM – 9:00 PM" },
    { day: "Friday", hours: "9:00 AM – 9:00 PM" },
    { day: "Saturday", hours: "9:00 AM – 9:00 PM" },
    { day: "Sunday", hours: "9:00 AM – 9:00 PM" },
  ];

  // ✅ Map embed
  const mapEmbedSrc = useMemo(() => {
    const q = encodeURIComponent(`${addressLine1}, ${cityStateZip}`);
    return `https://www.google.com/maps?q=${q}&output=embed`;
  }, [addressLine1, cityStateZip]);

  // ✅ Form state
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [message, setMessage] = useState("");

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    const subject = encodeURIComponent(`${BUSINESS_NAME} — Website message`);
    const body = encodeURIComponent(
      `Name: ${name}\nPhone: ${phone}\nEmail: ${fromEmail}\n\nMessage:\n${message}\n`
    );

    // mailto (works now, no backend)
    window.location.href = `mailto:${emailTo}?subject=${subject}&body=${body}`;
  }

  return (
    <main className="bg-zinc-50">
      {/* Header */}
      <section className="border-b bg-white">
        <div className="mx-auto max-w-6xl px-4 py-10">
          <h1 className="text-3xl font-bold tracking-tight text-neutral-900 md:text-4xl">
            Contact
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-neutral-600">
            Questions, catering requests, or quick pickup? Reach out anytime.
          </p>
        </div>
      </section>

      {/* Content */}
      <section className="mx-auto max-w-6xl px-4 py-10">
        <div className="grid gap-8 lg:grid-cols-2">
          {/* Left column: Info cards + map */}
          <div className="space-y-6">
            {/* Contact info */}
            <div className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm">
              <h2 className="text-lg font-bold text-neutral-900">Get in touch</h2>
              <div className="mt-4 space-y-3 text-sm text-neutral-700">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    Phone
                  </div>
                  <a
                    className="mt-1 inline-block underline underline-offset-2"
                    href={`tel:${PHONE_NUMBER_TEL}`}
                  >
                    {PHONE_NUMBER_DISPLAY}
                  </a>
                </div>

                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    Email
                  </div>
                  <a
                    className="mt-1 inline-block underline underline-offset-2"
                    href={`mailto:${emailTo}`}
                  >
                    {emailTo}
                  </a>
                </div>

                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    Address
                  </div>
                  <div className="mt-1">
                    {addressLine1}
                    <br />
                    {cityStateZip}
                  </div>
                </div>

                <div className="pt-2 flex flex-wrap gap-3">
                  <a
                    href={CLOVER_PICKUP_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand-dark"
                  >
                    Order online
                  </a>
                </div>
              </div>
            </div>

            {/* Parking */}
            <div className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm">
              <h2 className="text-lg font-bold text-neutral-900">Parking</h2>
              <p className="mt-2 text-sm text-neutral-700">
                Parking is available in the plaza’s shared parking lot for all
                businesses. There are no reserved spaces except designated
                handicap parking.
              </p>
            </div>

            {/* Hours */}
            <div className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm">
              <h2 className="text-lg font-bold text-neutral-900">Hours</h2>
              <p className="mt-2 text-sm text-neutral-600">
                Hours may change on holidays—call to confirm.
              </p>

              <div className="mt-4 overflow-hidden rounded-2xl border border-neutral-200">
                <table className="w-full text-left text-sm">
                  <tbody>
                    {hours.map((row) => (
                      <tr
                        key={row.day}
                        className="border-b border-neutral-200 last:border-b-0"
                      >
                        <td className="w-32 bg-neutral-50 px-4 py-3 font-semibold text-neutral-800">
                          {row.day}
                        </td>
                        <td className="px-4 py-3 text-neutral-700">{row.hours}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Map */}
 
            <div className="overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-sm">
              <div className="flex items-center justify-between gap-3 border-b border-neutral-200 p-6">
                <div>
                  <div className="text-lg font-bold text-neutral-900">Map</div>
                  <div className="mt-1 text-xs text-neutral-500">
                    {addressLine1}, {cityStateZip}
                  </div>
                </div>
                <a
                  href={`https://www.google.com/maps?q=${encodeURIComponent(
                    `${addressLine1}, ${cityStateZip}`
                  )}`}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-xl border border-neutral-200 bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-50"
               >
                  Open in Google Maps
                </a>
              </div>
              <iframe
                title="Google Map"
                src={mapEmbedSrc}
                className="h-[360px] w-full"
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
              />
            </div>
          </div>

          {/* Right column: Stylish form */}
          <div className="rounded-3xl border border-neutral-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-bold text-neutral-900">
              Send us a message
            </h2>
            <p className="mt-2 text-sm text-neutral-600">
              We’ll get back to you as soon as we can.
            </p>

            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              {/* Name */}
              <div>
                <label className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Name
                </label>
                <div className="mt-2 flex items-center gap-3 rounded-2xl border border-neutral-200 bg-white px-4 py-3 focus-within:ring-2 focus-within:ring-brand/30">
                  <span className="text-neutral-400">👤</span>
                  <input
                    className="w-full bg-transparent text-sm outline-none"
                    placeholder="Your name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                  />
                </div>
              </div>

              {/* Phone */}
              <div>
                <label className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Phone
                </label>
                <div className="mt-2 flex items-center gap-3 rounded-2xl border border-neutral-200 bg-white px-4 py-3 focus-within:ring-2 focus-within:ring-brand/30">
                  <span className="text-neutral-400">📱</span>
                  <input
                    className="w-full bg-transparent text-sm outline-none"
                    placeholder="Your phone"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    inputMode="tel"
                  />
                </div>
              </div>

              {/* Email */}
              <div>
                <label className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Email
                </label>
                <div className="mt-2 flex items-center gap-3 rounded-2xl border border-neutral-200 bg-white px-4 py-3 focus-within:ring-2 focus-within:ring-brand/30">
                  <span className="text-neutral-400">✉️</span>
                  <input
                    className="w-full bg-transparent text-sm outline-none"
                    placeholder="Your email address"
                    value={fromEmail}
                    onChange={(e) => setFromEmail(e.target.value)}
                    type="email"
                    required
                  />
                </div>
              </div>

              {/* Message */}
              <div>
                <label className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                  Message
                </label>
                <div className="mt-2 rounded-2xl border border-neutral-200 bg-white px-4 py-3 focus-within:ring-2 focus-within:ring-brand/30">
                  <textarea
                    className="h-36 w-full resize-none bg-transparent text-sm outline-none"
                    placeholder="Your message"
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    required
                  />
                </div>
              </div>

              <button
                type="submit"
                className="w-full rounded-2xl bg-brand px-5 py-3 text-sm font-semibold text-white hover:bg-brand-dark"
              >
                Submit
              </button>

              {/* Small note */}
              <p className="text-xs text-neutral-500">
                Tip: This form opens your email app for now (development stage).
                Later we can connect it to a real form backend.
              </p>
            </form>

            {/* ✅ YES: same style can be used for Catering/Reservations */}
            <div className="mt-8 rounded-2xl bg-neutral-50 p-4">
              <div className="text-sm font-semibold text-neutral-900">
                Catering / Reservations
              </div>
              <p className="mt-1 text-sm text-neutral-600">
                Email us and include the date, time, guest count, and what you’d
                like to order.
              </p>
              <a
                className="mt-3 inline-flex rounded-xl bg-white px-4 py-2 text-sm font-semibold text-neutral-900 ring-1 ring-neutral-200 hover:bg-neutral-100"
                href={`mailto:${emailTo}?subject=${encodeURIComponent(
                  `${BUSINESS_NAME} — Catering / Reservation`
                )}`}
              >
                Email catering/reservations
              </a>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

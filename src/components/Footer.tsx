import { Link } from "react-router-dom";

export default function Footer() {
  return (
    <footer className="border-t bg-white">
      <div className="mx-auto max-w-6xl px-4 py-10 text-sm text-zinc-600">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="font-semibold text-zinc-900">Nazar Restaurant & Bakery</div>
            <div className="text-xs">
              West Haven, CT • Turkish cuisine • Fresh bakery
            </div>
          </div>
          <div className="flex flex-col gap-1 text-xs md:items-end">
            <Link
              to="/vip"
              className="font-extrabold text-[#1E7A3A] underline underline-offset-2"
            >
              Join the VIP Club →
            </Link>
            <span>© {new Date().getFullYear()} Nazar. All rights reserved.</span>
          </div>
        </div>
      </div>
    </footer>
  );
}

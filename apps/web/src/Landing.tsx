import { Link } from 'react-router';

export default function Landing() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-4 py-12">
      <h1 className="text-4xl font-extrabold leading-tight">One stock count for your shop, WhatsApp, Instagram and website.</h1>
      <p className="text-lg text-body">Trawer helps Nigerian wholesalers and retailers sell everywhere without overselling. Wholesale prices for approved buyers, cartons and pieces, offline POS, payments by transfer.</p>
      <Link to="/dashboard" className="inline-flex min-h-14 items-center justify-center rounded-xl bg-[#0F766E] px-6 text-lg font-semibold text-white">Open your shop</Link>
    </main>
  );
}

// A synthetic search outside Malaysia, for the web UI's end-to-end tests:
// dentists in Lisbon, Portugal (geocoded to PT), with names in Latin with
// accents, Japanese and Arabic, a very long name, and numbers from Portugal,
// Japan, the UAE and Germany. Phone numbers written with a leading `+` keep
// their own country; national ones are read as Portuguese.
//
// - `Clínica Dentária São João`: Portuguese mobile, website with an email.
// - `東京デンタルクリニック`: Japanese mobile; its "website" is a Facebook page.
// - `عيادة النور لطب الأسنان`: UAE mobile; its "website" is a WhatsApp link.
// - The long Portuguese name: Lisbon landline, so no WhatsApp link.
// - `Zahnarztpraxis Müller`: German landline, no website.
// - `Clínica Sorriso`: Lisbon landline with a website, so a website and no WhatsApp.

import { makeBatch } from "./batch.js";

type SyntheticPlace = Parameters<typeof makeBatch>[0][number];

export const WORLD_GEOCODE = { lat: 38.7223, lon: -9.1393, countryCode: "PT" };

export const WORLD_LONG_NAME = "Centro de Medicina Dentária Integrada e Ortodontia Avançada do Parque das Nações";

export const WORLD_PLACES: SyntheticPlace[] = [
  {
    title: "Clínica Dentária São João",
    phone: "912 345 678",
    website: "https://clinica-sao-joao.test/",
  },
  {
    title: "東京デンタルクリニック",
    phone: "+81 90-1234-5678",
    website: "https://www.facebook.com/tokyo.dental.test",
  },
  {
    title: "عيادة النور لطب الأسنان",
    phone: "+971 50 123 4567",
    website: "https://wa.me/971501234567",
  },
  { title: WORLD_LONG_NAME, phone: "21 000 0000" },
  { title: "Zahnarztpraxis Müller", phone: "+49 30 1234567" },
  { title: "Clínica Sorriso", phone: "21 111 1111", website: "https://clinica-sorriso.test/" },
].map((p, i) => ({
  category: "Dentist",
  address: `${i + 1} Rua de Teste, 1000-001 Lisboa`,
  place_id: `ZZWORLD-${i + 1}`,
  data_id: `0x1:0x${(i + 1).toString(16)}`,
  latitude: 38.72 + i / 1000,
  longitude: -9.14 + i / 1000,
  review_rating: 4.5,
  review_count: (i + 1) * 7,
  ...p,
}));

export const WORLD_BATCH = makeBatch(WORLD_PLACES);

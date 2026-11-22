import { describe, expect, it } from "vitest";
import { classifyEmail, emailTypeCsvLabel, emailTypeLabel, GENERIC_EMAIL_PREFIXES } from "../src/core/enrich/emailType.js";

describe("GENERIC_EMAIL_PREFIXES", () => {
  it("exports a fixed, non-empty lowercase list including core and multilingual role addresses", () => {
    expect(Array.isArray(GENERIC_EMAIL_PREFIXES)).toBe(true);
    expect(GENERIC_EMAIL_PREFIXES.length).toBeGreaterThan(10);
    for (const prefix of [
      "info", "sales", "hello", "admin", "enquiry", "booking", "support", "contact", "office", "billing",
      "pertanyaan", "jualan", "tempahan", "pentadbir",
      "kefu", "lianxi",
      "contato", "atendimento", "contacto", "ventas",
      "bonjour", "accueil", "kontakt", "anfrage", "impressum",
      "tittor", "soptham", "lienhe", "cskh", "layanan", "kontak",
    ]) {
      expect(GENERIC_EMAIL_PREFIXES).toContain(prefix);
    }
    for (const prefix of GENERIC_EMAIL_PREFIXES) {
      expect(prefix).toBe(prefix.toLowerCase());
    }
    expect(new Set(GENERIC_EMAIL_PREFIXES).size).toBe(GENERIC_EMAIL_PREFIXES.length);
  });
});

describe("classifyEmail", () => {
  it("classifies every prefix in GENERIC_EMAIL_PREFIXES as generic", () => {
    for (const prefix of GENERIC_EMAIL_PREFIXES) {
      expect(classifyEmail(`${prefix}@shop.test`), prefix).toBe("generic");
    }
  });

  it("classifies multilingual generic role addresses as generic", () => {
    const cases = [
      // Malay & Indonesian
      "pertanyaan@syarikat.my", "jualan@kedai.my", "tempahan@hotel.my", "pentadbir@majlis.my",
      "hubungi@acara.my", "bantuan@servis.my", "layanan@toko.id", "kontak@usaha.id", "pemesanan@resto.id",
      // Chinese pinyin
      "kefu@gongsi.cn", "lianxi@huodong.cn", "zixun@company.cn", "xiaoshou@firm.cn", "yuyue@clinic.cn",
      // Thai romanized
      "tittor@shop.th", "tidtor@hotel.th", "soptham@tour.th", "borikan@spa.th",
      // Vietnamese romanized
      "lienhe@congty.vn", "hotro@dichvu.vn", "cskh@banhang.vn", "tuvan@dulich.vn",
      // Portuguese & Spanish
      "contato@empresa.com.br", "atendimento@loja.com.br", "vendas@negocio.pt",
      "contacto@tienda.es", "ventas@empresa.es", "atencion@servicio.es",
      // French
      "bonjour@atelier.fr", "accueil@hotel.fr", "comptabilite@societe.fr", "service-client@boutique.fr",
      // German
      "kontakt@praxis.de", "anfrage@firma.de", "buchhaltung@kanzlei.de", "kundenservice@laden.de",
    ];
    for (const email of cases) {
      expect(classifyEmail(email), email).toBe("generic");
    }
  });

  it("does not classify short common first names like khai, jong, or ola as generic", () => {
    expect(classifyEmail("khai@abc.com.my")).toBe("not_sure");
    expect(classifyEmail("jong@abc.com")).toBe("not_sure");
    expect(classifyEmail("ola@abc.com")).toBe("not_sure");
    expect(classifyEmail("khai@abc.com.my")).not.toBe("generic");
    expect(classifyEmail("jong@abc.com")).not.toBe("generic");
  });

  it("ignores case and +tags when classifying generic addresses", () => {
    expect(classifyEmail("Info@shop.test")).toBe("generic");
    expect(classifyEmail("SALES@SHOP.TEST")).toBe("generic");
    expect(classifyEmail("Info+promo@shop.test")).toBe("generic");
    expect(classifyEmail("  hello+newsletter@shop.test  ")).toBe("generic");
    expect(classifyEmail("Booking+2026@hotel.test")).toBe("generic");
    expect(classifyEmail("Pertanyaan+web@acara.my")).toBe("generic");
  });

  it("classifies two-part separated name-like local parts as personal", () => {
    expect(classifyEmail("john.doe@shop.test")).toBe("personal");
    expect(classifyEmail("siti.nur@events.my")).toBe("personal");
    expect(classifyEmail("muhammad_ali@events.my")).toBe("personal");
    expect(classifyEmail("jean-luc@studio.fr")).toBe("personal");
    expect(classifyEmail("j.tan@agency.my")).toBe("personal");
    expect(classifyEmail("j_tan@agency.my")).toBe("personal");
    expect(classifyEmail("j-tan@agency.my")).toBe("personal");
    expect(classifyEmail("Jane.Doe+work@shop.test")).toBe("personal");
    expect(classifyEmail("dr.tanaka@dental.test")).toBe("personal");
    expect(classifyEmail("ahmad.farid@events.my")).toBe("personal");
    expect(classifyEmail("wei.li@studio.my")).toBe("personal");
  });

  it("classifies single-word, shop, place, and non-name addresses as not_sure", () => {
    for (const email of [
      "john@shop.test",
      "alice@shop.test",
      "jtan@agency.my",
      "bakery@shop.test",
      "flowers@shop.test",
      "kitchen@shop.test",
      "photography@shop.test",
      "sweetcakes@shop.test",
      "kualalumpur@shop.test",
      "dubai@shop.test",
      "bangkok@shop.test",
      "jakarta@shop.test",
      "zzmark1@shop-1.test",
      "infoman@shop.test",
      "sales.john@shop.test",
      "info.kl@events.my",
      "event2026@gmail.com",
      "kl_events@gmail.com",
      "my-events@gmail.com",
      "starlightevents@gmail.com",
      "prestigioo@prestigioo.com.my",
      "digital.studio@gmail.com",
      "acme.corp@acme.com.my",
      "kl@events.my",
      "12345@shop.test",
    ]) {
      expect(classifyEmail(email), email).toBe("not_sure");
    }
  });

  it("falls back to not_sure for malformed inputs without @", () => {
    expect(classifyEmail("info")).toBe("not_sure");
    expect(classifyEmail("@shop.test")).toBe("not_sure");
    expect(classifyEmail("")).toBe("not_sure");
  });
});

describe("emailType labels", () => {
  it("maps raw EmailType values to user words for the page and CSV/Excel", () => {
    expect(emailTypeLabel("generic")).toBe("shared inbox");
    expect(emailTypeLabel("personal")).toBe("a person's address");
    expect(emailTypeLabel("not_sure")).toBe("not sure");

    expect(emailTypeCsvLabel("generic")).toBe("shared inbox");
    expect(emailTypeCsvLabel("personal")).toBe("a person's address");
    expect(emailTypeCsvLabel("not_sure")).toBe("not sure");
    expect(emailTypeCsvLabel("unknown")).toBe("");
    expect(emailTypeCsvLabel(undefined)).toBe("");
  });
});

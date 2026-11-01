/** Zod validation shared by web, POS and webhooks. Every external input goes through one of these. */
import { z } from 'zod';

const NG_PHONE = /^(\+?234|0)[789][01]\d{8}$/;

export const phoneSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, ''))
  .refine((s) => NG_PHONE.test(s), { message: 'Enter a valid Nigerian phone number' })
  .transform((s) => (s.startsWith('+') ? s : s.startsWith('234') ? `+${s}` : `+234${s.slice(1)}`));

export const otpSchema = z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code');
export const uuid = z.string().uuid();
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, 'Use 3–40 letters, numbers or dashes');
export const hexColour = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
export const koboSchema = z.number().int().nonnegative().max(1_000_000_000_00);
export const salesChannel = z.enum(['web', 'whatsapp', 'instagram', 'facebook', 'pos']);
export const buyerType = z.enum(['wholesaler', 'retailer', 'retail_buyer']);
export const staffRole = z.enum(['owner', 'manager', 'cashier', 'store_keeper', 'rider']);
export const paymentMethod = z.enum(['cash', 'card_terminal', 'transfer', 'ussd', 'qr', 'virtual_account', 'store_credit']);

export const orderItemInput = z.object({
  variant_id: uuid,
  unit_id: uuid.optional(),
  qty: z.number().int().positive().max(1_000_000),
});

export const addressSchema = z.object({
  line1: z.string().trim().min(3).max(200),
  area: z.string().trim().max(100).optional(),
  city: z.string().trim().min(2).max(80),
  state: z.string().trim().min(2).max(40),
  landmark: z.string().trim().max(200).optional(),
});

export const checkoutInput = z.object({
  business_id: uuid,
  channel: salesChannel.default('web'),
  client_id: uuid.optional(),
  customer_id: uuid.optional(),
  device_id: uuid.optional(),
  items: z.array(orderItemInput).min(1).max(200),
  delivery_method: z.enum(['pickup', 'delivery', 'in_store']).default('pickup'),
  delivery_address: addressSchema.optional(),
  buyer_name: z.string().trim().max(120).optional(),
  buyer_phone: phoneSchema.optional(),
  note: z.string().trim().max(1000).optional(),
}).refine((v) => v.delivery_method !== 'delivery' || v.delivery_address, {
  message: 'Delivery address is required', path: ['delivery_address'],
});
export type CheckoutInput = z.infer<typeof checkoutInput>;

export const registerBuyerInput = z.object({
  buyer_type: buyerType,
  name: z.string().trim().min(2).max(120),
  business_name: z.string().trim().max(160).optional(),
  cac_number: z.string().trim().regex(/^(RC|BN|IT)?\s?\d{4,8}$/i, 'CAC numbers look like RC123456 or BN1234567').optional().or(z.literal('')),
  accept_terms: z.literal(true, { errorMap: () => ({ message: 'Please accept the terms and privacy policy' }) }),
  marketing_opt_in: z.boolean().default(false),
});

export const onboardingInput = z.object({
  name: z.string().trim().min(2).max(120),
  slug: slugSchema,
  kind: z.enum(['wholesaler', 'retailer']),
  brand_colour: hexColour,
  display_name: z.string().trim().max(80).default(''),
});

export const variantInput = z.object({
  id: uuid.optional(),
  colour: z.string().trim().max(60).optional().nullable(),
  colour_hex: hexColour.optional().nullable(),
  size: z.string().trim().max(40).optional().nullable(),
  sku: z.string().trim().max(64).optional().nullable(),
  barcode: z.string().trim().regex(/^\d{8,14}$/).optional().nullable().or(z.literal('')),
  retail_price_kobo: koboSchema,
  cost_kobo: koboSchema.optional().nullable(),
  opening_stock: z.number().int().min(0).max(10_000_000).optional(),
  image_path: z.string().max(400).optional().nullable(),
});

export const productInput = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).default(''),
  category: z.string().trim().max(80).optional().nullable(),
  brand: z.string().trim().max(80).optional().nullable(),
  base_unit: z.string().trim().default('piece'),
  packs: z.array(z.object({ unit: z.string().trim().min(1), factor: z.number().int().min(2).max(100_000) })).max(5).default([]),
  status: z.enum(['draft', 'active']).default('draft'),
  source: z.enum(['manual', 'snap', 'import', 'text_list']).default('manual'),
  variants: z.array(variantInput).min(1).max(100),
});
export type ProductInput = z.infer<typeof productInput>;

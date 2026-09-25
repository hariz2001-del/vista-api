import { PrismaClient, type ModifierType } from '@prisma/client'
import bcrypt from 'bcryptjs'

/**
 * Ported from the POS's fake account (`pos-vista/src/data/fake-account/`), with
 * the same UUIDs, so the two sides line up when the client is wired to this API.
 *
 * Malay dish names are kept deliberately — that is what the stall calls them.
 * Everything around them is English.
 */

// The repository holds no credentials. The account's first password and
// counter PIN come from SEED_PASSWORD and SEED_PIN in the environment.
try {
  process.loadEnvFile()
} catch {
  // No .env — CI and the server supply the variables directly.
}

const prisma = new PrismaClient()

/** The demo business. Everything below belongs to it. */
const BUSINESS = 'c1000000-0000-4000-8000-000000000001'

const BRAND_FOOD = 'a1000000-0000-4000-8000-000000000001'
const BRAND_DRINKS = 'a1000000-0000-4000-8000-000000000002'

const CAT = {
  rice: 'b1000000-0000-4000-8000-000000000001',
  burgers: 'b1000000-0000-4000-8000-000000000002',
  noodles: 'b1000000-0000-4000-8000-000000000003',
  sides: 'b1000000-0000-4000-8000-000000000004',
  coffee: 'b1000000-0000-4000-8000-000000000005',
  tea: 'b1000000-0000-4000-8000-000000000006',
  cold: 'b1000000-0000-4000-8000-000000000007',
}

type SeedOption = { name: string; priceSen: number; type: ModifierType }
type SeedGroup = {
  key: string
  name: string
  description?: string
  minSelect: number
  maxSelect: number
  options: SeedOption[]
}

const SPICE_LEVEL: SeedGroup = {
  key: 'spice',
  name: 'Spice level',
  description: 'Pick one, required',
  minSelect: 1,
  maxSelect: 1,
  options: [
    { name: 'Not Spicy', priceSen: 0, type: 'REMOVAL' },
    { name: 'Medium', priceSen: 0, type: 'REMOVAL' },
    { name: 'Extra Spicy', priceSen: 0, type: 'REMOVAL' },
  ],
}

const FOOD_ADD_ONS: SeedGroup = {
  key: 'food-add',
  name: 'Add extras',
  description: 'Choose up to two extras',
  minSelect: 0,
  maxSelect: 2,
  options: [
    { name: 'Extra Sambal', priceSen: 150, type: 'ADD_ON' },
    { name: 'Fried Egg', priceSen: 200, type: 'ADD_ON' },
    { name: 'Extra Cheese', priceSen: 200, type: 'ADD_ON' },
  ],
}

const FOOD_REMOVALS: SeedGroup = {
  key: 'food-remove',
  name: 'Remove ingredients',
  description: 'Instructions for the kitchen',
  minSelect: 0,
  maxSelect: 3,
  options: [
    { name: 'No Onion', priceSen: 0, type: 'REMOVAL' },
    { name: 'No Cucumber', priceSen: 0, type: 'REMOVAL' },
    { name: 'No Sauce', priceSen: 0, type: 'REMOVAL' },
  ],
}

const CUP_SIZE: SeedGroup = {
  key: 'cup',
  name: 'Cup size',
  description: 'Pick one, required',
  minSelect: 1,
  maxSelect: 1,
  options: [
    { name: 'Regular', priceSen: 0, type: 'REMOVAL' },
    { name: 'Large', priceSen: 150, type: 'ADD_ON' },
  ],
}

const DRINK_ADD_ONS: SeedGroup = {
  key: 'drink-add',
  name: 'Drink add-ons',
  minSelect: 0,
  maxSelect: 2,
  options: [
    { name: 'Extra Shot', priceSen: 250, type: 'ADD_ON' },
    { name: 'Oat Milk', priceSen: 200, type: 'ADD_ON' },
    { name: 'Gula Melaka', priceSen: 100, type: 'ADD_ON' },
  ],
}

const DRINK_REMOVALS: SeedGroup = {
  key: 'drink-remove',
  name: 'Drink preferences',
  description: 'Choose up to two',
  minSelect: 0,
  maxSelect: 2,
  options: [
    { name: 'Less Sweet', priceSen: 0, type: 'REMOVAL' },
    { name: 'No Sugar', priceSen: 0, type: 'REMOVAL' },
    { name: 'No Ice', priceSen: 0, type: 'REMOVAL' },
  ],
}

type SeedProduct = {
  id: string
  name: string
  description: string
  brandId: string
  categoryId: string
  priceSen: number
  image: string
  soldOut?: boolean
  groups: SeedGroup[]
}

const PRODUCTS: SeedProduct[] = [
  { id: '20000000-0000-4000-8000-000000000001', name: 'Nasi Lemak Ayam', description: 'Spiced chicken, sambal and fried egg', brandId: BRAND_FOOD, categoryId: CAT.rice, priceSen: 1200, image: '/products/nasi-lemak.svg', groups: [SPICE_LEVEL, FOOD_ADD_ONS, FOOD_REMOVALS] },
  { id: '20000000-0000-4000-8000-000000000002', name: 'Nasi Goreng Kampung', description: 'Anchovies, water spinach and hot chilli', brandId: BRAND_FOOD, categoryId: CAT.rice, priceSen: 1000, image: '/products/nasi-goreng.svg', groups: [SPICE_LEVEL, FOOD_ADD_ONS] },
  { id: '20000000-0000-4000-8000-000000000003', name: 'Burger Ayam Special', description: 'Chicken patty, egg and house sauce', brandId: BRAND_FOOD, categoryId: CAT.burgers, priceSen: 1050, image: '/products/burger.svg', groups: [FOOD_ADD_ONS, FOOD_REMOVALS] },
  { id: '20000000-0000-4000-8000-000000000004', name: 'Roti John Daging', description: 'Long roll with egg and minced beef', brandId: BRAND_FOOD, categoryId: CAT.burgers, priceSen: 950, image: '/products/roti-john.svg', groups: [FOOD_REMOVALS] },
  { id: '20000000-0000-4000-8000-000000000005', name: 'Mee Goreng Mamak', description: 'Spicy fried yellow noodles', brandId: BRAND_FOOD, categoryId: CAT.noodles, priceSen: 900, image: '/products/mee-goreng.svg', groups: [SPICE_LEVEL, FOOD_ADD_ONS] },
  { id: '20000000-0000-4000-8000-000000000006', name: 'Ayam Goreng Berempah', description: 'Two pieces, crisp outside and tender inside', brandId: BRAND_FOOD, categoryId: CAT.sides, priceSen: 800, image: '/products/ayam-goreng.svg', groups: [] },
  { id: '20000000-0000-4000-8000-000000000007', name: 'Kentang Goreng', description: 'Crisp and hot', brandId: BRAND_FOOD, categoryId: CAT.sides, priceSen: 600, image: '/products/fries.svg', soldOut: true, groups: [] },
  { id: '30000000-0000-4000-8000-000000000001', name: 'Kopi Ais', description: 'Iced white coffee', brandId: BRAND_DRINKS, categoryId: CAT.coffee, priceSen: 550, image: '/products/coffee.svg', groups: [CUP_SIZE, DRINK_ADD_ONS, DRINK_REMOVALS] },
  { id: '30000000-0000-4000-8000-000000000002', name: 'Milo Ais Kaw', description: 'Thick iced Milo', brandId: BRAND_DRINKS, categoryId: CAT.coffee, priceSen: 600, image: '/products/milo.svg', groups: [CUP_SIZE, DRINK_REMOVALS] },
  { id: '30000000-0000-4000-8000-000000000003', name: 'Teh Limau Ais', description: 'Fresh lime tea', brandId: BRAND_DRINKS, categoryId: CAT.tea, priceSen: 450, image: '/products/tea.svg', groups: [DRINK_REMOVALS] },
  { id: '30000000-0000-4000-8000-000000000004', name: 'Teh O Ais Limau', description: 'No milk, with lime', brandId: BRAND_DRINKS, categoryId: CAT.tea, priceSen: 400, image: '/products/teh-o.svg', groups: [DRINK_REMOVALS] },
  { id: '30000000-0000-4000-8000-000000000005', name: 'Soda Laici', description: 'Iced lychee soda', brandId: BRAND_DRINKS, categoryId: CAT.cold, priceSen: 700, image: '/products/soda.svg', groups: [DRINK_REMOVALS] },
  { id: '30000000-0000-4000-8000-000000000006', name: 'Sirap Bandung', description: 'Pink rose milk', brandId: BRAND_DRINKS, categoryId: CAT.cold, priceSen: 500, image: '/products/bandung.svg', groups: [CUP_SIZE, DRINK_REMOVALS] },
  { id: '30000000-0000-4000-8000-000000000007', name: 'Air Kelapa Muda', description: 'Fresh coconut, straight from the fruit', brandId: BRAND_DRINKS, categoryId: CAT.cold, priceSen: 800, image: '/products/kelapa.svg', soldOut: true, groups: [] },
]

async function main(): Promise<void> {
  // Order matters: children before parents, and every sale-bearing table is
  // Restrict-on-delete, so a reseed on a database with orders will refuse
  // rather than quietly destroying history.
  // Owner books, sessions and partners reference users and brands, so they go
  // before either. This clears every business, not only the demo one: the seed
  // is for a development or test database, never a live one.
  await prisma.handoffCode.deleteMany()
  await prisma.promotion.deleteMany()
  await prisma.session.deleteMany()
  await prisma.partner.deleteMany()
  await prisma.expense.deleteMany()
  await prisma.periodClosure.deleteMany()
  await prisma.terminalStatus.deleteMany()
  await prisma.ledgerEntry.deleteMany()
  // Corrections point at orders, so they go first or the order delete refuses.
  await prisma.correctionBrandDelta.deleteMany()
  await prisma.saleCorrection.deleteMany()
  await prisma.orderItemModifier.deleteMany()
  await prisma.orderItem.deleteMany()
  await prisma.order.deleteMany()
  await prisma.shift.deleteMany()
  await prisma.queueCounter.deleteMany()
  await prisma.modifierItem.deleteMany()
  await prisma.modifierGroup.deleteMany()
  await prisma.product.deleteMany()
  await prisma.category.deleteMany()
  await prisma.brand.deleteMany()
  await prisma.accountSettings.deleteMany()
  await prisma.user.deleteMany()
  await prisma.business.deleteMany()

  const seedPassword = process.env.SEED_PASSWORD
  const seedPin = process.env.SEED_PIN
  if (!seedPassword) throw new Error('SEED_PASSWORD is not set — see .env.example.')
  if (!seedPin || !/^\d{4}$/.test(seedPin)) throw new Error('SEED_PIN must be exactly 4 digits — see .env.example.')

  const [passwordHash, pinHash] = await Promise.all([
    bcrypt.hash(seedPassword, 10),
    bcrypt.hash(seedPin, 10),
  ])

  // The business profile and split the POS and RMS demos use.
  const settings = {
    businessName: 'Vista Demo Enterprise',
    outletName: 'Vista Counter · Section 7',
    // The demo is the stall partner settlement was built for.
    settlementEnabled: true,
    sharedOverheadFoodPct: 70,
    hostCommissionPct: 30,
    capitalAssetFoodPct: 50,
  }

  await prisma.business.create({ data: { id: BUSINESS, name: settings.businessName } })

  await prisma.user.createMany({
    data: [
      // The business's one account. It signs in to the counter (which then stays
      // signed in) and to the owner dashboard. The PIN is the counter PIN.
      { id: '10000000-0000-4000-8000-000000000001', businessId: BUSINESS, email: 'demo@vistahub.my', name: 'Vista Demo', role: 'OWNER', passwordHash, pinHash },
    ],
  })

  await prisma.accountSettings.create({ data: { businessId: BUSINESS, ...settings } })

  await prisma.brand.createMany({
    data: [
      { id: BRAND_FOOD, businessId: BUSINESS, name: 'Food', colour: '#ef6c35', softColour: '#fff0e8', sortOrder: 1 },
      { id: BRAND_DRINKS, businessId: BUSINESS, name: 'Drinks', colour: '#087f8c', softColour: '#e4f6f7', sortOrder: 2 },
    ],
  })

  // The partners settlement pays — names, not logins. Hariz owns Food; Iman hosts
  // the stall and owns Drinks. Renamed from RMS Settings.
  await prisma.partner.createMany({
    data: [
      { businessId: BUSINESS, name: 'Hariz', brandId: BRAND_FOOD, role: 'FOOD_OWNER' },
      { businessId: BUSINESS, name: 'Iman', brandId: BRAND_DRINKS, role: 'STALL_HOST' },
    ],
  })

  await prisma.category.createMany({
    data: [
      { id: CAT.rice, businessId: BUSINESS, brandId: BRAND_FOOD, name: 'Rice', sortOrder: 1 },
      { id: CAT.burgers, businessId: BUSINESS, brandId: BRAND_FOOD, name: 'Burgers', sortOrder: 2 },
      { id: CAT.noodles, businessId: BUSINESS, brandId: BRAND_FOOD, name: 'Noodles', sortOrder: 3 },
      { id: CAT.sides, businessId: BUSINESS, brandId: BRAND_FOOD, name: 'Sides', sortOrder: 4 },
      { id: CAT.coffee, businessId: BUSINESS, brandId: BRAND_DRINKS, name: 'Coffee', sortOrder: 5 },
      { id: CAT.tea, businessId: BUSINESS, brandId: BRAND_DRINKS, name: 'Tea', sortOrder: 6 },
      { id: CAT.cold, businessId: BUSINESS, brandId: BRAND_DRINKS, name: 'Cold Drinks', sortOrder: 7 },
    ],
  })

  for (const [index, product] of PRODUCTS.entries()) {
    await prisma.product.create({
      data: {
        id: product.id,
        businessId: BUSINESS,
        brandId: product.brandId,
        categoryId: product.categoryId,
        name: product.name,
        description: product.description,
        basePriceSen: product.priceSen,
        imageUrl: product.image,
        isSoldOut: product.soldOut ?? false,
        sortOrder: index + 1,
        // A modifier group belongs to exactly one product in this schema, so a
        // group reused across products is seeded once per product.
        modifierGroups: {
          create: product.groups.map((group, groupIndex) => ({
            name: group.name,
            description: group.description ?? null,
            minSelect: group.minSelect,
            maxSelect: group.maxSelect,
            sortOrder: groupIndex + 1,
            items: {
              create: group.options.map((option, optionIndex) => ({
                name: option.name,
                priceSen: option.priceSen,
                type: option.type,
                sortOrder: optionIndex + 1,
              })),
            },
          })),
        },
      },
    })
  }

  const counts = {
    users: await prisma.user.count(),
    brands: await prisma.brand.count(),
    categories: await prisma.category.count(),
    products: await prisma.product.count(),
    modifierGroups: await prisma.modifierGroup.count(),
    modifierItems: await prisma.modifierItem.count(),
    accountSettings: await prisma.accountSettings.count(),
    partners: await prisma.partner.count(),
  }
  console.log('Seeded:', counts)
}

main()
  .catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())

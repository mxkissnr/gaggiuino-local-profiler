const { z } = require('zod');

const annotationSchema = z.object({
    coffee:        z.string().max(200).optional(),
    grindSetting:  z.string().max(50).optional(),
    notes:         z.string().max(2000).optional(),
    drinkType:     z.string().max(50).optional(),
    milkType:      z.string().max(50).optional(),
    rating:        z.number().int().min(1).max(5).nullable().optional(),
    score:         z.number().nullable().optional(),
    recipeId:      z.number().int().nullable().optional(),
    beanBagId:     z.number().int().nullable().optional(),
}).passthrough();

const beanSchema = z.object({
    name:      z.string().min(1).max(200),
    roaster:   z.string().max(200).optional().default(''),
    origin:    z.string().max(200).optional().default(''),
    variety:   z.string().max(200).optional().default(''),
    process:   z.string().max(200).optional().default(''),
    roastDate: z.string().optional().default(''),
    weight:    z.number().positive().optional().nullable(),
    notes:     z.string().max(1000).optional().default(''),
}).passthrough();

const grinderSchema = z.object({
    name:  z.string().min(1).max(200),
    notes: z.string().max(1000).optional().default(''),
}).passthrough();

const recipeSchema = z.object({
    name:  z.string().min(1).max(200),
    notes: z.string().max(1000).optional().default(''),
    steps: z.array(z.object({
        label: z.string().max(200),
        value: z.string().max(200),
    })).optional().default([]),
}).passthrough();

const maintenanceLogSchema = z.object({
    task:    z.string().min(1).max(100),
    notes:   z.string().max(1000).optional().default(''),
    machine: z.string().max(200).optional().default(''),
});

const orderSchema = z.object({
    drinkId:    z.string().min(1).max(50),
    personName: z.string().min(1).max(200),
    notes:      z.string().max(500).optional().default(''),
}).passthrough();

module.exports = {
    annotationSchema,
    beanSchema,
    grinderSchema,
    recipeSchema,
    maintenanceLogSchema,
    orderSchema,
};

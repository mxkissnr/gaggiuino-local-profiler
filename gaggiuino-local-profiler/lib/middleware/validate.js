const { ZodError } = require('zod');

function validate(schema, source = 'body') {
    return (req, res, next) => {
        const result = schema.safeParse(req[source]);
        if (!result.success) {
            return res.status(400).json({
                error:  'Validation failed',
                issues: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
            });
        }
        req[source] = result.data;
        next();
    };
}

module.exports = { validate };

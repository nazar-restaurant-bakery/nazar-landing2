import { couponAutomationHandler } from '../../../functions/_lib/couponAutomation.ts';
declare const Deno: {
    serve: (fn: (request: Request) => Promise<Response>) => void;
    env: {
        toObject: () => Record<string, string | undefined>;
    };
};
if (typeof Deno !== 'undefined')
    Deno.serve(request => couponAutomationHandler()(request, Deno.env.toObject()));

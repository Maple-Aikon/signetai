interface Env {
	GHL_API_KEY: string;
	RATE_LIMITER: RateLimit;
}

const ALLOWED_ORIGINS = ["https://signetai.sh", "https://www.signetai.sh"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function corsHeaders(origin: string): Record<string, string> {
	if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
	return { "Access-Control-Allow-Origin": origin };
}


export const onRequestPost: PagesFunction<Env> = async (context) => {
	const origin = context.request.headers.get("Origin") ?? "";
	const headers = {
		...corsHeaders(origin),
		"Content-Type": "application/json",
	};

	// Rate limit by IP — 10 submissions per 60 seconds
	const ip = context.request.headers.get("CF-Connecting-IP") ?? "unknown";
	const { success } = await context.env.RATE_LIMITER.limit({ key: ip });
	if (!success) {
		return new Response(JSON.stringify({ error: "Too many requests" }), {
			status: 429,
			headers,
		});
	}

	try {
		const body = (await context.request.json()) as {
			firstName?: string;
			lastName?: string;
			phone?: string;
			email?: string;
			optin?: boolean;
		};

		const firstName = body.firstName?.trim() ?? "";
		const lastName = body.lastName?.trim() ?? "";
		const phone = body.phone?.trim() ?? "";
		const email = body.email?.trim().toLowerCase() ?? "";
		const optin = body.optin === true;

		if (!firstName || !lastName) {
			return new Response(JSON.stringify({ error: "First name and last name required" }), {
				status: 400,
				headers,
			});
		}

		if (email && !EMAIL_RE.test(email)) {
			return new Response(JSON.stringify({ error: "Invalid email address" }), {
				status: 400,
				headers,
			});
		}

		const phoneDigits = phone.replace(/\D/g, "");
		if (phoneDigits && phoneDigits.length !== 10) {
			return new Response(JSON.stringify({ error: "Phone must be a 10-digit US number" }), {
				status: 400,
				headers,
			});
		}

		// Create/update contact in GoHighLevel
		if (context.env.GHL_API_KEY) {
			const ghlRes = await fetch("https://rest.gohighlevel.com/v1/contacts/", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${context.env.GHL_API_KEY}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					firstName,
					lastName,
					...(email ? { email } : {}),
					// Phone digits only, prepend +1 for US (form enforces 10-digit US format)
					...(phoneDigits ? { phone: `+1${phoneDigits}` } : {}),
					tags: ["signet new lead"],
					source: "signetai.sh",
					// Requires a custom field named "newsletter_optin" in your GHL account
					customField: [{ id: "newsletter_optin", value: optin ? "yes" : "no" }],
				}),
			});

			if (!ghlRes.ok) {
				const err = await ghlRes.text();
				console.error("GHL contacts error:", ghlRes.status, err);
				return new Response(JSON.stringify({ error: "Signup failed" }), {
					status: 502,
					headers,
				});
			}
		}

		return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
	} catch (e) {
		console.error("Optin error:", e);
		return new Response(JSON.stringify({ error: "Server error" }), {
			status: 500,
			headers,
		});
	}
};

export const onRequestOptions: PagesFunction = async (context) => {
	const origin = context.request.headers.get("Origin") ?? "";
	return new Response(null, {
		status: 204,
		headers: {
			...corsHeaders(origin),
			"Access-Control-Allow-Methods": "POST, OPTIONS",
			"Access-Control-Allow-Headers": "Content-Type",
		},
	});
};

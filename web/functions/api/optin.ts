interface Env {
	RESEND_API_KEY: string;
	RESEND_AUDIENCE_ID: string;
	GHL_API_KEY: string;
	RATE_LIMITER: RateLimit;
	// Email address to receive applicant notifications (e.g. team@signetai.sh)
	NOTIFY_EMAIL?: string;
	// Verified sending address in Resend (e.g. noreply@signetai.sh)
	FROM_EMAIL?: string;
}

const ALLOWED_ORIGINS = ["https://signetai.sh", "https://www.signetai.sh"];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function corsHeaders(origin: string): Record<string, string> {
	if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
	return { "Access-Control-Allow-Origin": origin };
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
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

		// Add to Resend contacts audience only when email is provided
		if (email) {
			const contactRes = await fetch(
				`https://api.resend.com/audiences/${context.env.RESEND_AUDIENCE_ID}/contacts`,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${context.env.RESEND_API_KEY}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						email,
						first_name: firstName,
						last_name: lastName,
						unsubscribed: !optin,
					}),
				},
			);

			if (!contactRes.ok) {
				const err = await contactRes.text();
				console.error("Resend contacts error:", contactRes.status, err);
				return new Response(JSON.stringify({ error: "Signup failed" }), {
					status: 502,
					headers,
				});
			}
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
					tags: ["community-optin"],
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

		// Send notification email with all fields if NOTIFY_EMAIL is configured
		const notifyEmail = context.env.NOTIFY_EMAIL;
		const fromEmail = context.env.FROM_EMAIL ?? "noreply@signetai.sh";

		if (notifyEmail) {
			// Escape all user values before HTML interpolation
			const safeName = `${escapeHtml(firstName)} ${escapeHtml(lastName)}`;
			const safeEmail = escapeHtml(email);
			const safePhone = escapeHtml(phone);

			const emailRes = await fetch("https://api.resend.com/emails", {
				method: "POST",
				headers: {
					Authorization: `Bearer ${context.env.RESEND_API_KEY}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					from: `Signet Community <${fromEmail}>`,
					to: [notifyEmail],
					subject: `New community applicant: ${safeName}`,
					html: `
						<p><strong>Name:</strong> ${safeName}</p>
						<p><strong>Email:</strong> ${safeEmail || "—"}</p>
						<p><strong>Phone:</strong> ${safePhone || "—"}</p>
						<p><strong>Newsletter opt-in:</strong> ${optin ? "Yes" : "No"}</p>
					`.trim(),
				}),
			});

			if (!emailRes.ok) {
				// Non-fatal — contact was already stored
				console.error("Resend notification error:", emailRes.status, await emailRes.text());
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

import { NextRequest, NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { sessionOptions, SessionData } from "@/lib/session";
import { verifyPassword } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const { password } = await request.json();

  if (typeof password !== "string" || password.length === 0) {
    return NextResponse.json({ error: "Password required" }, { status: 400 });
  }

  if (!process.env.APP_PASSWORD_HASH) {
    return NextResponse.json(
      { error: "Server misconfigured: APP_PASSWORD_HASH not set" },
      { status: 500 },
    );
  }

  const isValid = await verifyPassword(
    password,
    process.env.APP_PASSWORD_HASH as string,
  );

  if (!isValid) {
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 });
  }

  const response = NextResponse.json({ success: true });
  const session = await getIronSession<SessionData>(
    request,
    response,
    sessionOptions,
  );
  session.authenticated = true;
  await session.save();

  return response;
}

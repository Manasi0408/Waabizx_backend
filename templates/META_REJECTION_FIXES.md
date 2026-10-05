# Meta Template Rejection - Common Issues & Fixes

## Why Your Template Was Rejected

Meta has strict policies for **financial/loan templates**. Here are the main issues with your template:

### ❌ Issues Found:

1. **"PRE-APPROVED" Language**
   - Meta rejects misleading claims like "PRE-APPROVED PERSONAL LOAN"
   - **Fix:** Remove or rephrase to "Loan Offer" or "Eligible for Loan"

2. **Too Many Variables (13 variables)**
   - Meta prefers fewer variables (ideally under 10)
   - **Fix:** Reduce to essential variables only (6-8 max)

3. **Misleading Claims**
   - "NO KYC DOCUMENT IS REQUIRED" is misleading and violates financial regulations
   - **Fix:** Remove or clarify that documents are required for verification

4. **Button Text Issues**
   - "YES/APPLY" might be too promotional
   - **Fix:** Use simpler text like "INTERESTED" or "LEARN MORE"

5. **Missing Proper Disclaimers**
   - Financial templates need clear disclaimers about approval process
   - **Fix:** Add: "Loan approval is subject to verification and credit assessment"

6. **Promotional Language**
   - "Great chance" sounds too salesy
   - **Fix:** Use neutral, factual language

## ✅ Fixed Template Structure

Use `template_fixed.json` which includes:
- ✅ Reduced variables (6 instead of 13)
- ✅ Proper disclaimers
- ✅ No misleading claims
- ✅ Compliant button text
- ✅ Professional, factual language

## How to Check Rejection Reason

After submitting, check the API response for:
- `rejectionReason`: Specific reason Meta rejected it
- `qualityRating`: Quality score if available

## Meta's Financial Template Guidelines

1. **No Misleading Claims**: Cannot claim pre-approval without verification
2. **Clear Disclaimers**: Must state that approval is subject to verification
3. **Accurate Information**: All rates, fees, and terms must be accurate
4. **Compliance**: Must comply with local financial regulations
5. **Professional Tone**: Avoid overly promotional language

## Next Steps

1. Use the fixed template (`template_fixed.json`)
2. Submit with a new name (e.g., `icicifresh999old_v2`)
3. Wait for Meta's review (24-48 hours typically)
4. Check status via: `GET /api/templates/meta`

## Alternative: Use UTILITY Category

If your template is for existing customers, consider using **UTILITY** category instead of **MARKETING**:
- UTILITY templates have less strict approval requirements
- But can only be sent to customers who have opted in


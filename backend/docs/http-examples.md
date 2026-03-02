# Refillit API HTTP Examples (MVP)

## Health

```bash
curl -i http://localhost:4000/api/health
```

## Doctor: Create Prescription

```bash
curl -i -X POST http://localhost:4000/api/doctor/prescription \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer DOCTOR_JWT" \
  -d '{
    "patientId": null,
    "meds": [{"ndcCode":"M001","name":"Amlodipine","strength":"5mg","qty":30}],
    "allowedRefills": 3,
    "expiryDate": "2026-04-01",
    "allowSubstitution": false,
    "controlledSubstance": false
  }'
```

Response includes `prescription`, `linkCode`, and `qrDataUrl`.

## Register (Patient)

```bash
curl -i -X POST http://localhost:4000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "fullName": "Jane Brown",
    "email": "jane@example.com",
    "phone": "+1-876-555-0100",
    "password": "ChangeMe123!"
  }'
```

## Login (Email)

```bash
curl -i -X POST http://localhost:4000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "jane@example.com",
    "password": "ChangeMe123!"
  }'
```

## Get Current User

```bash
curl -i http://localhost:4000/api/auth/me \
  -H "Authorization: Bearer YOUR_JWT_HERE"
```

## Patient: Link Prescription by Code

```bash
curl -i -X POST http://localhost:4000/api/patient/prescriptions/PRESC_ID/link \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer PATIENT_JWT" \
  -d '{"code":"LINKCODE"}'
```

## Patient: Create Order

```bash
curl -i -X POST http://localhost:4000/api/patient/orders \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer PATIENT_JWT" \
  -d '{
    "prescId": "PRESC_ID",
    "pharmacyId": "PHARMACY_PROFILE_ID",
    "deliveryOption": "delivery",
    "payment": {"method":"wipay","amount":3500,"status":"confirmed"}
  }'
```

## Patient: Respond to Substitution

```bash
curl -i -X POST http://localhost:4000/api/patient/orders/ORDER_ID/substitution \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer PATIENT_JWT" \
  -d '{"decision":"accepted"}'
```

## Pharmacy: Verify Prescription Signature

```bash
curl -i -X POST http://localhost:4000/api/pharmacy/verify-prescription \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer PHARMACY_JWT" \
  -d '{"prescId":"PRESC_ID"}'
```

## Pharmacy: Update Order Status

```bash
curl -i -X POST http://localhost:4000/api/pharmacy/orders/ORDER_ID/status \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer PHARMACY_JWT" \
  -d '{"status":"ready"}'
```

## Pharmacy: Propose Substitution

```bash
curl -i -X POST http://localhost:4000/api/pharmacy/orders/ORDER_ID/substitution \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer PHARMACY_JWT" \
  -d '{
    "items": [{"ndcCode":"M999","name":"Generic Amlodipine","strength":"5mg","qty":30}]
  }'
```

## NHF: Create Claim (Patient)

```bash
curl -i -X POST http://localhost:4000/api/nhf/claims \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer PATIENT_JWT" \
  -d '{
    "prescId": "PRESC_ID",
    "patientNhfId": "NHF123456",
    "orderId": "ORDER_ID",
    "amountCovered": 1200
  }'
```

## NHF: Status Callback

```bash
curl -i -X POST http://localhost:4000/api/nhf/callback \
  -H "Content-Type: application/json" \
  -H "x-nhf-token: YOUR_NHF_CALLBACK_SECRET" \
  -d '{
    "claimId": "CLAIM_ID",
    "status": "approved",
    "amountCovered": 1200
  }'
```

## Dispatch: Assign Courier

```bash
curl -i -X POST http://localhost:4000/api/dispatch/assign \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer PHARMACY_OR_ADMIN_JWT" \
  -d '{
    "orderId": "ORDER_ID",
    "courierId": "COURIER_USER_ID"
  }'
```

## Dispatch: Proof of Delivery

```bash
curl -i -X POST http://localhost:4000/api/dispatch/ORDER_ID/pod \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer COURIER_JWT" \
  -d '{
    "method": "otp",
    "proof": "123456"
  }'
```

## Dispatch: Delivery Failed

```bash
curl -i -X POST http://localhost:4000/api/dispatch/ORDER_ID/fail \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer COURIER_JWT" \
  -d '{"reason":"Recipient not home"}'
```

## Admin: Audit Logs

```bash
curl -i http://localhost:4000/api/admin/audit?limit=50&offset=0 \
  -H "Authorization: Bearer ADMIN_JWT"
```

## MOH: Aggregated Report

```bash
curl -i -X POST http://localhost:4000/api/moh/reports \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer MOH_JWT" \
  -d '{"from":"2026-01-01","to":"2026-02-01"}'
```

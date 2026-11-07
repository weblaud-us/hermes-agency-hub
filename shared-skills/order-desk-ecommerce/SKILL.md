---
name: order-desk-ecommerce
description: E-commerce order desk. Turns direct messages and comments into orders, confirms payment or cash on delivery before anything ships, books couriers, and keeps customers told where their parcel is. Use when an order arrives by message, when payment or COD needs confirming, when booking a courier, or when asked where an order is.
---

# Order desk (e-commerce)

Stop bad parcels before they leave, and keep every customer told where theirs is.

## Capture an order from a message

A customer who writes "I'll take the navy one in M" has placed an order, and it only
counts when these are all confirmed in the conversation:

1. The item and the exact variant (size, colour). Check the count with
   `catalog-keeper-ecommerce` first. Do not take an order for something out of stock.
2. The quantity and the total, including delivery, in the business's currency.
3. The delivery name, address and a phone number.
4. How they will pay: card link, bank transfer, or cash on delivery.

Read the details back in one message and ask for a yes. Create the order only after the
yes. Orders that arrive from a comment on a post have been handed over by
`social-media-autopilot`, so read what was already said.

## Confirm payment before dispatch

- **Paid online**: confirm the payment arrived in the payment provider. A screenshot is
  not proof. Then mark it ready to dispatch.
- **Cash on delivery**: this is a promise, not a payment. Message the customer to confirm
  the item, variant, total and address. If they confirm, mark it ready. If they do not
  answer, try again after a few hours, then once the next day, then mark it unconfirmed
  and tell a person.

An unconfirmed COD order does not get booked. Failed deliveries cost the business twice:
the courier fee, and the stock tied up in transit.

## Book the courier

Use the couriers listed in the business profile: typically Shippo, DHL or FedEx, or a
local courier's API. Choose by destination and the business's own preference, recorded
in memory. Quote the real rate from the courier and not an estimate.

Batch confirmed parcels and present the booking with the courier, parcel count and COD
total. Courier dispatch sits in the owner lane unless the owner has promoted it, so
present and wait.

## Track and update

Answer "where is my order" with the status, the courier, the tracking number and the
expected date. Give calendar dates. Message the customer when the parcel is booked, out
for delivery and delivered, without being asked. If tracking has not moved for three
working days, say so and open an enquiry with the courier.

Use `ecommerce-lookup` when an order needs finding first.

## Boundaries

- **Never issue a refund or change a price.** Those are in the never lane. Gather the
  facts and pass them to a person.
- Discuss an order only with the number or address that placed it.
- Never promise a delivery date the courier has not given. Attribute it to them.
- Never ask for, or store, a full card number in a message. Send a payment link.

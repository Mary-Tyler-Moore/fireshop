import {Component, ElementRef, OnInit, ViewChild} from '@angular/core';
import {StateService} from '../../shared/services/state/state.service';
import {RxDestroy} from '@jaspero/ng-helpers';
import {CartService} from '../../shared/services/cart/cart.service';
import {HttpClient} from '@angular/common/http';
import {AngularFirestore} from '@angular/fire/firestore';
import {AngularFireAuth} from '@angular/fire/auth';
import {FormBuilder, FormGroup, Validators} from '@angular/forms';
import {Router} from '@angular/router';
import {
  BehaviorSubject,
  from,
  Observable,
  of,
  Subscription,
  throwError
} from 'rxjs';
import {
  finalize,
  map,
  shareReplay,
  switchMap,
  take,
  takeUntil,
  tap
} from 'rxjs/operators';
import {FirestoreCollections} from '@jf/enums/firestore-collections.enum';
import {ENV_CONFIG} from '@jf/consts/env-config.const';
import {environment} from '../../../environments/environment';
import {STATIC_CONFIG} from '@jf/consts/static-config.const';
import {toStripeFormat} from '@jf/utils/stripe-format.ts';
import * as nanoid from 'nanoid';

@Component({
  selector: 'jfs-checkout',
  templateUrl: './checkout.component.html',
  styleUrls: ['./checkout.component.scss']
})
export class CheckoutComponent extends RxDestroy implements OnInit {
  constructor(
    public cartService: CartService,
    private http: HttpClient,
    private afs: AngularFirestore,
    private afAuth: AngularFireAuth,
    private fb: FormBuilder,
    private router: Router,
    private state: StateService
  ) {
    super();
  }

  @ViewChild('card')
  cardEl: ElementRef<HTMLElement>;

  stripe: {
    stripe: stripe.Stripe;
    cardObj: stripe.elements.Element;
    cardChanges$: Observable<stripe.elements.ElementChangeResponse>;
    clientSecret: string;
  };
  loading$ = new BehaviorSubject(false);
  billingInfo$: Observable<FormGroup>;
  orderItems: any;
  prices = {};

  private shippingSubscription: Subscription;

  ngOnInit() {
    this.cartService.totalPrice$.subscribe(val => {
      this.prices['totalPrice'] = val;
    });
    this.billingInfo$ = this.afAuth.user.pipe(
      switchMap(user => {
        if (user) {
          return this.afs
            .doc(`${FirestoreCollections.Customers}/${user.uid}`)
            .valueChanges()
            .pipe(
              take(1),
              map(value => this.filterData(value))
            );
        } else {
          return of(this.filterData());
        }
      })
    );

    this.billingInfo$.pipe(take(1)).subscribe(() => {
      setTimeout(() => this.connectStripe());
    });
  }

  filterData(value: any = {}) {
    const group = this.fb.group({
      billing: this.checkForm(value.billing ? value.billing : {}),
      shippingInfo: value.shippingInfo || true,
      saveInfo: true
    });

    if (this.shippingSubscription) {
      this.shippingSubscription.unsubscribe();
    }

    this.shippingSubscription = group
      .get('shippingInfo')
      .valueChanges.pipe(takeUntil(this.destroyed$))
      .subscribe(value => {
        if (value) {
          group.removeControl('shipping');
        } else {
          group.addControl('shipping', this.checkForm(value.shipping || {}));
        }
      });

    return group;
  }

  checkForm(data: any) {
    return this.fb.group({
      firstName: [data.firstName || '', Validators.required],
      lastName: [data.lastName || '', Validators.required],
      email: [data.email || '', Validators.required],
      phone: [data.phone || '', Validators.required],
      city: [data.city || '', Validators.required],
      zip: [data.zip || '', Validators.required],
      country: [data.country || '', Validators.required],
      line1: [data.line1 || '', Validators.required],
      line2: [data.line2 || '']
    });
  }

  toggleState() {
    this.state.checkOutToggle = true;
  }

  checkOut(data) {
    if (data.saveInfo) {
      this.afs
        .doc(
          `${FirestoreCollections.Customers}/${
            this.afAuth.auth.currentUser.uid
          }`
        )
        .update(data);
    }

    this.loading$.next(true);

    from(
      this.stripe['handleCardPayment'](
        this.stripe.clientSecret,
        this.stripe.cardObj,
        {
          payment_method_data: {
            billing_details: {
              name: `${data.billing.firstName} ${data.billing.lastName}`
            }
          }
        }
      )
    )
      .pipe(
        switchMap(({paymentIntent, error}) => {
          if (error) {
            return throwError(error);
          }

          const prices = {};
          for (let key in this.prices) {
            prices[key] = toStripeFormat(this.prices[key]);
          }

          return this.afs
            .collection(FirestoreCollections.Orders)
            .doc(nanoid())
            .set({
              paymentIntentId: paymentIntent.id,
              ...(this.afAuth.auth.currentUser
                ? {customerId: this.afAuth.auth.currentUser.uid}
                : {}),
              ...(this.afAuth.auth.currentUser
                ? {customerName: this.afAuth.auth.currentUser.displayName}
                : {}),
              billing: data.billing,
              ...(data.shippingInfo ? {shipping: data.shipping} : {}),
              prices,
              orderItems: this.orderItems,
              time: Date.now()
            });
        }),
        finalize(() => this.loading$.next(false))
      )
      .subscribe(
        res => {
          this.router.navigate(['checkout/success']);
        },
        err => {
          this.router.navigate(['checkout/error']);
        }
      );
  }

  private connectStripe() {
    const str = Stripe(ENV_CONFIG.stripe.token);
    const elements = str.elements();
    const cardObj = elements.create('card', {style: {}});

    cardObj.mount(this.cardEl.nativeElement);

    const cardChanges$ = new Observable<stripe.elements.ElementChangeResponse>(
      obs => {
        cardObj.on('change', event => {
          obs.next(event);
        });
      }
    ).pipe(shareReplay(1));

    this.stripe = {
      stripe: str,
      cardObj,
      cardChanges$,
      clientSecret: ''
    };

    this.cartService.items$
      .pipe(
        take(1),
        switchMap(items => {
          this.orderItems = items.map(val => ({
            id: val.productId,
            quantity: val.quantity
          }));

          return this.http.post<{clientSecret: string}>(
            `${environment.restApi}/stripe/checkout`,
            {
              orderItems: this.orderItems,
              lang: STATIC_CONFIG.lang
            }
          );
        })
      )
      .subscribe(res => {
        this.stripe.clientSecret = res.clientSecret;
      });
  }
}
